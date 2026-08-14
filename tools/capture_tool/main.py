import asyncio
import hashlib
import hmac
import secrets
import time
import uuid
import json
import os
import queue
import socket
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, simpledialog, ttk
from PIL import ImageTk
import qrcode

import requests
import yaml
from mitmproxy import http, options
from mitmproxy.tools.dump import DumpMaster

try:
    from capture_tool_config import SERVER_URL, UPDATE_TOKEN
except ImportError:
    SERVER_URL = "https://api.cn.orangechai.fun/grab"
    UPDATE_TOKEN = ""



def identity_path():
    root = Path(os.environ.get("APPDATA", Path.home())) / "CourtCredentialCapture"
    root.mkdir(parents=True, exist_ok=True)
    return root / "device.json"


def load_device_identity():
    path = identity_path()
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    identity = {"deviceId": str(uuid.uuid4()), "secret": secrets.token_hex(32), "deviceName": socket.gethostname()}
    path.write_text(json.dumps(identity), encoding="utf-8")
    return identity


def signed_headers(identity, payload):
    timestamp = str(int(time.time() * 1000))
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    body_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    signature = hmac.new(identity["secret"].encode("utf-8"), (timestamp + "." + body_hash).encode("utf-8"), hashlib.sha256).hexdigest()
    return {"x-device-id": identity["deviceId"], "x-device-timestamp": timestamp, "x-device-signature": signature}
def app_root():
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parents[2]


def local_ip():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def find_free_port(start=8080):
    for port in range(start, start + 100):
        probe = socket.socket()
        try:
            probe.bind(("0.0.0.0", port))
            return port
        except OSError:
            pass
        finally:
            probe.close()
    raise RuntimeError("没有可用代理端口")


def cert_path():
    return Path(os.environ.get("USERPROFILE", Path.home())) / ".mitmproxy" / "mitmproxy-ca-cert.pem"


class CaptureAddon:
    PAYMENT_WORDS = ("payment", "paysign", "prepay", "unifiedorder", "cashier", "wechatpay", "wxpay", "bankcard", "支付密码")
    DROP_KEYS = ("password", "passwd", "paysign", "prepay", "bank", "cardno", "cvv", "idcard", "paymenttoken", "privatekey")
    SKIP_HOSTS = ("api.cn.orangechai.fun", "servicewechat.com", "qlogo.cn", "weixin.qq.com")

    def __init__(self, capture_config, events):
        self.config = capture_config
        self.events = events
        self.seen = set()
        self.pending = {}

    @classmethod
    def is_payment(cls, text):
        lowered = str(text or "").lower()
        return any(word in lowered for word in cls.PAYMENT_WORDS)

    @classmethod
    def sanitize(cls, value, depth=0):
        if depth > 6:
            return "[depth-limit]"
        if isinstance(value, list):
            return [cls.sanitize(item, depth + 1) for item in value[:12]]
        if isinstance(value, dict):
            output = {}
            for key, item in list(value.items())[:80]:
                if any(word in str(key).lower() for word in cls.DROP_KEYS):
                    continue
                output[str(key)] = cls.sanitize(item, depth + 1)
            return output
        if isinstance(value, str):
            return value[:300] + ("…" if len(value) > 300 else "")
        return value

    @staticmethod
    def parse_json_body(message):
        try:
            text = message.get_text(strict=False)
            return json.loads(text) if text else None
        except Exception:
            return None

    def learning_request(self, flow):
        request = flow.request
        host = (request.host or "").lower()
        if any(host == item or host.endswith("." + item) for item in self.SKIP_HOSTS):
            return
        if request.scheme != "https" or self.is_payment(request.pretty_url):
            return
        body = self.parse_json_body(request)
        if self.is_payment(json.dumps(body, ensure_ascii=False) if body is not None else ""):
            return
        ignored_headers = {"cookie", "content-length", "accept-encoding", "connection", "host", "user-agent", "referer"}
        request_headers = {}
        for name, value in request.headers.items():
            if name.lower() in ignored_headers or self.is_payment(name):
                continue
            request_headers[name] = str(value)[:500]
        self.pending[flow.id] = {
            "method": request.method,
            "url": request.pretty_url,
            "requestHeaders": request_headers,
            "requestBody": self.sanitize(body),
            "stage": self.config.get("learningStage", "account"),
        }

    def request(self, flow: http.HTTPFlow):
        if self.config.get("learningMode"):
            self.learning_request(flow)
            return
        request = flow.request
        host = (request.host or "").lower()
        path = request.path or "/"
        hosts = [str(item).lower() for item in self.config.get("hosts", [])]
        paths = [str(item) for item in self.config.get("paths", [])]
        if hosts and host not in hosts:
            return
        if paths and not any(self.match_path(path, pattern) for pattern in paths):
            return
        extracted = {}
        for name in self.config.get("headers", []):
            value = request.headers.get(name)
            if value:
                extracted[name] = value.strip()
        if not extracted:
            return
        fingerprint = tuple(sorted(extracted.items()))
        if fingerprint in self.seen:
            return
        self.seen.add(fingerprint)
        self.events.put({"kind": "credential", "host": host, "path": path, "headers": extracted, "url": request.pretty_url})

    def learning_response(self, flow):
        captured = self.pending.pop(flow.id, None)
        if not captured or not flow.response:
            return
        content_type = flow.response.headers.get("content-type", "").lower()
        response_body = self.parse_json_body(flow.response)
        if response_body is None and "json" not in content_type:
            return
        if self.is_payment(json.dumps(response_body, ensure_ascii=False) if response_body is not None else ""):
            return
        captured.update({
            "statusCode": flow.response.status_code,
            "responseBody": self.sanitize(response_body),
        })
        stage = captured.pop("stage", "account")
        self.events.put({"kind": "learning", "stage": stage, "event": captured})

    def response(self, flow: http.HTTPFlow):
        if self.config.get("learningMode"):
            self.learning_response(flow)
            return
        request = flow.request
        host = (request.host or "").lower()
        path = request.path or "/"
        hosts = [str(item).lower() for item in self.config.get("hosts", [])]
        discovery_paths = [str(item) for item in self.config.get("discoveryPaths", [])]
        if hosts and host not in hosts:
            return
        if not discovery_paths or not any(self.match_path(path, pattern) for pattern in discovery_paths):
            return
        try:
            payload = json.loads(flow.response.get_text(strict=False))
            slots = ((payload.get("result") or {}).get("slots") or [])
        except Exception:
            return
        courts = {}
        for slot in slots:
            provider_id = str(slot.get("txtClassroomUid") or slot.get("classroomUid") or "")
            if provider_id:
                courts[provider_id] = {"providerCourtId": provider_id, "name": slot.get("classRoomName") or provider_id}
        if courts:
            self.events.put({"kind": "discovery", "host": host, "path": path, "courts": list(courts.values())})

    @staticmethod
    def match_path(value, pattern):
        return value.startswith(pattern[:-1]) if pattern.endswith("*") else value == pattern

class ProxyController:
    def __init__(self, config, events, log):
        self.config = config
        self.events = events
        self.log = log
        self.master = None
        self.thread = None

    def start(self, port):
        self.thread = threading.Thread(target=self.run, args=(port,), daemon=True)
        self.thread.start()

    def run(self, port):
        async def runner():
            master = DumpMaster(options.Options(listen_host="0.0.0.0", listen_port=port), with_termlog=False, with_dumper=False)
            self.master = master
            master.addons.add(CaptureAddon(self.config, self.events))
            self.log("代理已启动：0.0.0.0:%s" % port)
            try:
                await master.run()
            except Exception as exc:
                self.log("代理停止：" + str(exc))
        asyncio.run(runner())

    def stop(self):
        if self.master:
            self.master.shutdown()
            self.master = None


class CaptureApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Court Capture")
        self.geometry("920x620")
        self.minsize(840, 560)
        self.configure(bg="#F4F5F7")
        self.events = queue.Queue()
        self.device_identity = load_device_identity()
        self.venues = []
        self.selected_venue = None
        self.controller = None
        self.port = None
        self.ready_timer = None
        self.discovery_session = None
        self.discovery_config = None
        self.discovery_window = None
        self.discovery_counts = {"account": 0, "courts": 0, "slots": 0, "booking": 0}
        self.discovery_uploads = 0
        self.status_text = tk.StringVar(value="正在连接服务器…")
        self.network_text = tk.StringVar(value="")
        self.capture_text = tk.StringVar(value="等待开始监听")
        self.build_style()
        self.build_ui()
        self.after(200, self.poll_events)
        self.after(400, self.load_venues)
        self.protocol("WM_DELETE_WINDOW", self.on_close)

    def build_style(self):
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("Root.TFrame", background="#F4F5F7")
        style.configure("Card.TFrame", background="#FFFFFF")
        style.configure("Title.TLabel", background="#F4F5F7", foreground="#1A1A1A", font=("Microsoft YaHei UI", 20, "bold"))
        style.configure("Sub.TLabel", background="#F4F5F7", foreground="#8E8E93", font=("Microsoft YaHei UI", 9))
        style.configure("CardTitle.TLabel", background="#FFFFFF", foreground="#1A1A1A", font=("Microsoft YaHei UI", 11, "bold"))
        style.configure("CardText.TLabel", background="#FFFFFF", foreground="#6B6B70", font=("Microsoft YaHei UI", 9))
        style.configure("Good.TLabel", background="#FFFFFF", foreground="#34A853", font=("Microsoft YaHei UI", 9, "bold"))
        style.configure("Bad.TLabel", background="#F4F5F7", foreground="#FF3B30", font=("Microsoft YaHei UI", 9, "bold"))
        style.configure("Muted.TLabel", background="#FFFFFF", foreground="#9A9AA0", font=("Microsoft YaHei UI", 9))
        style.configure("Accent.TButton", background="#C00038", foreground="#FFFFFF", borderwidth=0, padding=(16, 9), font=("Microsoft YaHei UI", 9, "bold"))
        style.map("Accent.TButton", background=[("active", "#A90031"), ("pressed", "#92002A"), ("disabled", "#D8D8DC")])
        style.configure("Secondary.TButton", background="#FFFFFF", foreground="#6B6B70", bordercolor="#E5E5EA", lightcolor="#E5E5EA", darkcolor="#E5E5EA", padding=(12, 8), font=("Microsoft YaHei UI", 9))
        style.map("Secondary.TButton", background=[("active", "#F7F7F9")], foreground=[("active", "#C00038")])
        style.configure("Treeview", background="#FFFFFF", fieldbackground="#FFFFFF", foreground="#1A1A1A", rowheight=38, borderwidth=0, relief="flat", font=("Microsoft YaHei UI", 9))
        style.configure("Treeview.Heading", background="#FAFAFB", foreground="#6B6B70", borderwidth=0, relief="flat", padding=(8, 9), font=("Microsoft YaHei UI", 9, "bold"))
        style.map("Treeview", background=[("selected", "#FCEBF0")], foreground=[("selected", "#C00038")])

    def build_ui(self):
        root = ttk.Frame(self, style="Root.TFrame", padding=22)
        root.pack(fill="both", expand=True)

        hero = tk.Frame(root, bg="#C00038", padx=26, pady=20, highlightthickness=0)
        hero.pack(fill="x", pady=(0, 14))
        hero_copy = tk.Frame(hero, bg="#C00038")
        hero_copy.pack(side="left", fill="x", expand=True)
        tk.Label(hero_copy, text="Court Capture", bg="#C00038", fg="#FFFFFF", font=("Microsoft YaHei UI", 20, "bold")).pack(anchor="w")
        tk.Label(hero_copy, text="球场凭证与新球场发现工具", bg="#C00038", fg="#F8DDE5", font=("Microsoft YaHei UI", 9)).pack(anchor="w", pady=(3, 0))
        self.server_badge = tk.Label(hero, text="● 服务器连接中", bg="#C00038", fg="#F8DDE5", font=("Microsoft YaHei UI", 9, "bold"))
        self.server_badge.pack(side="right", anchor="n", pady=4)

        toolbar = ttk.Frame(root, style="Card.TFrame", padding=(16, 12))
        toolbar.pack(fill="x", pady=(0, 12))
        ttk.Label(toolbar, text="球场与设备", style="CardTitle.TLabel").pack(side="left")
        ttk.Button(toolbar, text="刷新球场", style="Secondary.TButton", command=self.load_venues).pack(side="right")
        ttk.Button(toolbar, text="显示配对二维码", style="Secondary.TButton", command=self.show_pair_qr).pack(side="right", padx=(0, 8))
        ttk.Button(toolbar, text="发现新球场", style="Accent.TButton", command=self.start_discovery).pack(side="right", padx=(0, 8))

        list_card = ttk.Frame(root, style="Card.TFrame", padding=16)
        list_card.pack(fill="both", expand=True, pady=(0, 12))
        title_row = ttk.Frame(list_card, style="Card.TFrame")
        title_row.pack(fill="x", pady=(0, 10))
        ttk.Label(title_row, text="球场状态", style="CardTitle.TLabel").pack(side="left")
        ttk.Label(title_row, text="选择球场后即可监听凭证", style="Muted.TLabel").pack(side="right")
        columns = ("venue", "status", "detail", "capture")
        self.tree = ttk.Treeview(list_card, columns=columns, show="headings", selectmode="browse")
        headings = {"venue": "球场", "status": "凭证", "detail": "状态说明", "capture": "监听域名"}
        widths = {"venue": 235, "status": 90, "detail": 300, "capture": 180}
        for col in columns:
            self.tree.heading(col, text=headings[col])
            self.tree.column(col, width=widths[col], anchor="w")
        self.tree.pack(fill="both", expand=True)
        self.tree.bind("<<TreeviewSelect>>", self.on_select)

        control = ttk.Frame(root, style="Card.TFrame", padding=16)
        control.pack(fill="x", pady=(0, 12))
        info = ttk.Frame(control, style="Card.TFrame")
        info.pack(side="left", fill="x", expand=True)
        ttk.Label(info, textvariable=self.status_text, style="CardTitle.TLabel").pack(anchor="w")
        ttk.Label(info, textvariable=self.network_text, style="CardText.TLabel").pack(anchor="w", pady=(4, 0))
        ttk.Label(info, textvariable=self.capture_text, style="Good.TLabel").pack(anchor="w", pady=(4, 0))
        self.action = ttk.Button(control, text="开始监听", style="Accent.TButton", command=self.toggle_capture)
        self.action.pack(side="right", padx=(18, 0))

        log_card = ttk.Frame(root, style="Card.TFrame", padding=(14, 10))
        log_card.pack(fill="x")
        ttk.Label(log_card, text="运行记录", style="CardTitle.TLabel").pack(anchor="w", pady=(0, 7))
        self.log_text = tk.Text(log_card, height=4, bg="#FAFAFB", fg="#6B6B70", insertbackground="#C00038", relief="flat", borderwidth=0, state="disabled", font=("Consolas", 9), padx=8, pady=7)
        self.log_text.pack(fill="x")

    def show_pair_qr(self):
        payload = {"type": "court_capture_pair", "deviceId": self.device_identity["deviceId"], "publicKey": self.device_identity["secret"], "deviceName": self.device_identity["deviceName"]}
        image = qrcode.make(json.dumps(payload, ensure_ascii=False)).resize((320, 320))
        window = tk.Toplevel(self)
        window.title("扫码配对")
        photo = ImageTk.PhotoImage(image)
        label = ttk.Label(window, image=photo)
        label.image = photo
        label.pack(padx=24, pady=24)
        ttk.Label(window, text="请用 Chai 小程序“我的”页扫码配对").pack(pady=(0, 20))
    def start_discovery(self):
        if self.controller:
            messagebox.showinfo("监听进行中", "请先停止当前监听，再开始发现新球场。")
            return
        if not cert_path().exists():
            messagebox.showwarning("需要证书", "未检测到 mitmproxy 根证书：\n\n" + str(cert_path()))
            return
        venue_name = simpledialog.askstring("发现新球场", "请输入球场名称（稍后仍可修改）：", parent=self)
        if not venue_name or not venue_name.strip():
            return
        payload = {"venueName": venue_name.strip()}
        try:
            response = requests.post(
                SERVER_URL.rstrip("/") + "/api/venue-discovery/sessions",
                json=payload,
                headers=signed_headers(self.device_identity, payload),
                timeout=15,
            )
            response.raise_for_status()
            self.discovery_session = response.json()["sessionId"]
        except Exception as exc:
            messagebox.showerror("无法开始发现", "请先在 Chai 小程序中扫码配对这台电脑。\n\n" + str(exc))
            return
        self.discovery_counts = {"account": 0, "courts": 0, "slots": 0, "booking": 0}
        self.discovery_uploads = 0
        self.discovery_config = {"learningMode": True, "learningStage": "account"}
        self.port = find_free_port()
        self.controller = ProxyController(self.discovery_config, self.events, self.write_log)
        self.controller.start(self.port)
        self.action.configure(text="停止监听")
        self.network_text.set("发现代理：%s:%s · 请让微信/手机使用此代理" % (local_ip(), self.port))
        self.capture_text.set("新球场发现：账户验证阶段")
        self.show_discovery_window(venue_name.strip())

    def show_discovery_window(self, venue_name):
        if self.discovery_window and self.discovery_window.winfo_exists():
            self.discovery_window.destroy()
        window = tk.Toplevel(self)
        self.discovery_window = window
        window.title("新球场发现向导")
        window.geometry("650x500")
        window.configure(bg="#F4F5F7")
        window.transient(self)
        frame = ttk.Frame(window, style="Root.TFrame", padding=24)
        frame.pack(fill="both", expand=True)
        ttk.Label(frame, text="发现：" + venue_name, style="Title.TLabel").pack(anchor="w")
        ttk.Label(frame, text="按顺序完成四个阶段。切换阶段后再操作目标小程序。", style="Sub.TLabel").pack(anchor="w", pady=(4, 18))
        warning = "安全限制：不要输入支付密码，不要确认微信支付。最后一步只到出现付款页；支付接口和支付参数会被自动丢弃。"
        ttk.Label(frame, text=warning, style="Bad.TLabel", wraplength=590).pack(fill="x", pady=(0, 16))
        self.discovery_stage_text = tk.StringVar(value="当前：1. 账户验证")
        self.discovery_count_text = tk.StringVar(value="已采集 0 条接口")
        ttk.Label(frame, textvariable=self.discovery_stage_text, style="CardTitle.TLabel").pack(anchor="w", pady=(0, 6))
        ttk.Label(frame, textvariable=self.discovery_count_text, style="Muted.TLabel").pack(anchor="w", pady=(0, 16))
        stages = [
            ("account", "1. 账户验证", "打开目标小程序的“我的/余额/会员”页面"),
            ("courts", "2. 场地列表", "打开球场、项目或场地选择页面"),
            ("slots", "3. 时段价格", "选择日期，打开可预约时段和价格页面"),
            ("booking", "4. 生成订单", "选择一个场次并确认到出现付款页，然后立即停下"),
        ]
        for key, title, instruction in stages:
            row = ttk.Frame(frame, style="Card.TFrame", padding=10)
            row.pack(fill="x", pady=4)
            ttk.Button(row, text=title, command=lambda value=key, label=title: self.set_discovery_stage(value, label)).pack(side="left")
            ttk.Label(row, text=instruction, style="CardText.TLabel").pack(side="left", padx=12)
        footer = ttk.Frame(frame, style="Root.TFrame")
        footer.pack(fill="x", pady=(18, 0))
        ttk.Button(footer, text="取消发现", command=self.cancel_discovery).pack(side="left")
        ttk.Button(footer, text="完成采集并生成草稿", style="Accent.TButton", command=self.finalize_discovery).pack(side="right")

    def set_discovery_stage(self, stage, label):
        if not self.discovery_config:
            return
        if stage == "booking":
            confirmed = messagebox.askokcancel(
                "生成订单阶段",
                "此阶段可能在目标平台创建一个未支付订单。请只操作到出现付款页，不要输入支付密码或确认微信支付。\n\n是否继续？",
                parent=self.discovery_window,
            )
            if not confirmed:
                return
        self.discovery_config["learningStage"] = stage
        self.discovery_stage_text.set("当前：" + label)
        self.discovery_count_text.set("已采集 %d 条接口" % self.discovery_counts.get(stage, 0))
        self.capture_text.set("新球场发现：" + label)
        self.write_log("发现阶段切换为 " + label)

    def upload_learning_event(self, stage, event):
        session_id = self.discovery_session
        if not session_id:
            return
        payload = {"stage": stage, "event": event}
        try:
            response = requests.post(
                SERVER_URL.rstrip("/") + "/api/venue-discovery/sessions/" + session_id + "/events",
                json=payload,
                headers=signed_headers(self.device_identity, payload),
                timeout=20,
            )
            if response.status_code == 422:
                self.write_log("已忽略疑似支付接口")
                return
            response.raise_for_status()
            self.discovery_counts[stage] = self.discovery_counts.get(stage, 0) + 1
            count = self.discovery_counts[stage]
            self.after(0, lambda: self.discovery_count_text.set("已采集 %d 条接口" % count) if hasattr(self, "discovery_count_text") else None)
            self.write_log("[%s] 已安全采集 %s %s" % (stage, event.get("method"), event.get("url", "").split("?")[0]))
        except Exception as exc:
            self.write_log("发现记录上传失败：" + str(exc))
        finally:
            self.after(0, self.discovery_upload_finished)

    def discovery_upload_finished(self):
        self.discovery_uploads = max(0, self.discovery_uploads - 1)

    def finalize_discovery(self):
        if not self.discovery_session:
            return
        if self.discovery_uploads:
            messagebox.showinfo("正在整理", "还有 %d 条接口正在安全上传，请稍后再点完成。" % self.discovery_uploads, parent=self.discovery_window)
            return
        if self.controller:
            self.controller.stop()
            self.controller = None
            self.action.configure(text="开始监听")
        payload = {}
        try:
            response = requests.post(
                SERVER_URL.rstrip("/") + "/api/venue-discovery/sessions/" + self.discovery_session + "/finalize",
                json=payload,
                headers=signed_headers(self.device_identity, payload),
                timeout=20,
            )
            response.raise_for_status()
            manifest = response.json().get("manifest") or {}
            missing = manifest.get("missing") or []
            if missing:
                message = "已保存球场草稿，但以下阶段还没有可用接口：\n\n" + "、".join(missing) + "\n\n请重新发现并补充这些操作。"
                messagebox.showwarning("草稿需要补充", message, parent=self.discovery_window)
            else:
                messagebox.showinfo("采集完成", "四类接口均已收集。服务器已生成声明式草稿，接下来只会进行无支付自测，通过后才能启用。", parent=self.discovery_window)
            self.capture_text.set("新球场草稿已保存")
            self.write_log("发现会话已完成，状态：" + str(manifest.get("activation")))
        except Exception as exc:
            messagebox.showerror("生成草稿失败", str(exc), parent=self.discovery_window)
            return
        self.discovery_session = None
        self.discovery_config = None
        if self.discovery_window and self.discovery_window.winfo_exists():
            self.discovery_window.destroy()

    def cancel_discovery(self):
        if self.controller:
            self.controller.stop()
            self.controller = None
            self.action.configure(text="开始监听")
        session_id = self.discovery_session
        self.discovery_session = None
        self.discovery_config = None
        if session_id:
            def remove_session():
                try:
                    payload = {}
                    requests.delete(
                        SERVER_URL.rstrip("/") + "/api/venue-discovery/sessions/" + session_id,
                        json=payload,
                        headers=signed_headers(self.device_identity, payload),
                        timeout=15,
                    )
                except Exception as exc:
                    self.write_log("清理发现会话失败：" + str(exc))
            threading.Thread(target=remove_session, daemon=True).start()
        self.capture_text.set("新球场发现已取消")
        if self.discovery_window and self.discovery_window.winfo_exists():
            self.discovery_window.destroy()
    def load_venues(self):
        def worker():
            try:
                response = requests.get(SERVER_URL.rstrip("/") + "/api/venues", timeout=12)
                response.raise_for_status()
                self.after(0, lambda: self.apply_venues(response.json().get("venues", [])))
            except Exception as exc:
                self.after(0, lambda: self.server_error(str(exc)))
        threading.Thread(target=worker, daemon=True).start()

    def apply_venues(self, venues):
        self.venues = venues
        self.server_badge.configure(text="● 服务器在线", foreground="#4ade80")
        for item in self.tree.get_children():
            self.tree.delete(item)
        for venue in venues:
            capture = ((venue.get("raw") or {}).get("capture") or {})
            self.tree.insert("", "end", iid=venue.get("id"), values=(venue.get("name", venue.get("id")), "检测中…", "", ", ".join(capture.get("hosts", []))))
        self.status_text.set("已加载 %d 个球场" % len(venues))
        self.refresh_ready()
        if self.ready_timer:
            self.after_cancel(self.ready_timer)
        self.ready_timer = self.after(30000, self.refresh_ready)

    def refresh_ready(self):
        for venue in self.venues:
            threading.Thread(target=self.fetch_ready, args=(venue.get("id"),), daemon=True).start()

    def fetch_ready(self, venue_id):
        try:
            response = requests.get(
                SERVER_URL.rstrip("/") + "/api/ready/" + venue_id,
                headers=signed_headers(self.device_identity, {}),
                timeout=15,
            )
            data = response.json()
            self.after(0, lambda: self.apply_ready(venue_id, data))
        except Exception as exc:
            self.after(0, lambda: self.apply_ready(venue_id, {"ok": False, "detail": str(exc)}))

    def apply_ready(self, venue_id, data):
        if not self.tree.exists(venue_id):
            return
        venue = next((item for item in self.venues if item.get("id") == venue_id), {})
        capture = ((venue.get("raw") or {}).get("capture") or {})
        status = "READY" if data.get("detail", "").startswith("已登录") else "失效"
        self.tree.item(venue_id, values=(venue.get("name", venue_id), status, data.get("detail", ""), ", ".join(capture.get("hosts", []))))
        self.tree.tag_configure("ready", foreground="#4ade80")
        self.tree.tag_configure("bad", foreground="#fb7185")
        self.tree.item(venue_id, tags=("ready" if status == "READY" else "bad",))
        self.status_text.set("状态已更新 · " + venue_id)

    def on_select(self, _event=None):
        selected = self.tree.selection()
        self.selected_venue = next((item for item in self.venues if item.get("id") == selected[0]), None) if selected else None
        if self.selected_venue:
            self.capture_text.set("已选择：" + self.selected_venue.get("name", self.selected_venue.get("id", "")))

    def toggle_capture(self):
        if self.controller:
            self.controller.stop()
            self.controller = None
            self.action.configure(text="开始监听")
            self.network_text.set("")
            self.capture_text.set("监听已停止")
            return
        if not self.selected_venue:
            messagebox.showinfo("请选择球场", "请先从列表中选择一个球场。")
            return
        if not cert_path().exists():
            messagebox.showwarning("需要证书", "未检测到 mitmproxy 根证书：\n\n" + str(cert_path()))
            return
        capture = ((self.selected_venue.get("raw") or {}).get("capture") or {})
        if not capture.get("hosts"):
            messagebox.showerror("捕获配置缺失", "该球场没有 capture.hosts 配置。")
            return
        self.port = find_free_port()
        self.controller = ProxyController(capture, self.events, self.write_log)
        self.controller.start(self.port)
        self.action.configure(text="停止监听")
        self.network_text.set("代理地址：%s:%s · 手机 Wi-Fi 代理可直接使用" % (local_ip(), self.port))
        self.status_text.set("正在监听：" + self.selected_venue.get("name", ""))

    def poll_events(self):
        try:
            while True:
                item = self.events.get_nowait()
                if item.get("kind") == "learning":
                    stage = item.get("stage") or "account"
                    self.discovery_uploads += 1
                    threading.Thread(target=self.upload_learning_event, args=(stage, item.get("event") or {}), daemon=True).start()
                elif item.get("kind") == "discovery":
                    self.capture_text.set("捕获到球场列表，正在上传…")
                    self.upload_discovery(item.get("courts") or [])
                else:
                    capture = self.selected_venue.get("raw", {}).get("capture", {}) if self.selected_venue else {}
                    header_name = (capture.get("headers") or ["PSPLVISITORID"])[0]
                    value = item["headers"].get(header_name)
                    self.capture_text.set("捕获到 %s，正在上传…" % header_name)
                    self.write_log("捕获目标请求：" + item["host"] + item["path"])
                    self.upload(value)
        except queue.Empty:
            pass
        self.after(250, self.poll_events)

    def upload(self, value):
        venue_id = self.selected_venue.get("id")
        url = SERVER_URL.rstrip("/") + "/api/credentials/" + venue_id + "/ingest"
        try:
            payload = {"text": value}
            response = requests.post(url, json=payload, headers=signed_headers(self.device_identity, payload), timeout=15)
            response.raise_for_status()
            result = response.json()
            self.capture_text.set("上传完成 · ready=" + str(result.get("ready")))
            self.write_log("凭证已上传并完成服务器验证")
        except Exception as exc:
            self.capture_text.set("上传失败")
            self.write_log("上传失败：" + str(exc))
            messagebox.showerror("上传失败", str(exc))


    def upload_discovery(self, courts):
        venue_id = self.selected_venue.get("id")
        url = SERVER_URL.rstrip("/") + "/api/venues/" + venue_id + "/discover-capture"
        try:
            payload = {"courts": courts}
            response = requests.post(url, json=payload, headers=signed_headers(self.device_identity, payload), timeout=20)
            response.raise_for_status()
            count = len(response.json().get("discovered", []))
            self.capture_text.set("球场信息已上传 · %d 个场地" % count)
            self.write_log("仅上传了球场名称和上游ID")
        except Exception as exc:
            self.write_log("球场信息上传失败：" + str(exc))
    def server_error(self, error):
        self.server_badge.configure(text="● 服务器连接失败", foreground="#fb7185")
        self.status_text.set("无法读取球场列表")
        self.write_log(error)

    def write_log(self, message):
        def append():
            self.log_text.configure(state="normal")
            self.log_text.insert("end", message + "\\n")
            self.log_text.see("end")
            self.log_text.configure(state="disabled")
        self.after(0, append)

    def on_close(self):
        if self.ready_timer:
            self.after_cancel(self.ready_timer)
        if self.controller:
            self.controller.stop()
        self.destroy()


if __name__ == "__main__":
    CaptureApp().mainloop()
