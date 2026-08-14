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
from tkinter import messagebox, ttk
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
    def __init__(self, capture_config, events):
        self.config = capture_config
        self.events = events
        self.seen = set()

    def request(self, flow: http.HTTPFlow):
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


    def response(self, flow: http.HTTPFlow):
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
        self.configure(bg="#0f172a")
        self.events = queue.Queue()
        self.device_identity = load_device_identity()
        self.venues = []
        self.selected_venue = None
        self.controller = None
        self.port = None
        self.ready_timer = None
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
        style.configure("Root.TFrame", background="#0f172a")
        style.configure("Card.TFrame", background="#111c33")
        style.configure("Title.TLabel", background="#0f172a", foreground="#f8fafc", font=("Segoe UI", 22, "bold"))
        style.configure("Sub.TLabel", background="#0f172a", foreground="#94a3b8", font=("Segoe UI", 10))
        style.configure("CardTitle.TLabel", background="#111c33", foreground="#f8fafc", font=("Segoe UI", 11, "bold"))
        style.configure("CardText.TLabel", background="#111c33", foreground="#cbd5e1", font=("Segoe UI", 10))
        style.configure("Good.TLabel", background="#111c33", foreground="#4ade80", font=("Segoe UI", 10, "bold"))
        style.configure("Bad.TLabel", background="#111c33", foreground="#fb7185", font=("Segoe UI", 10, "bold"))
        style.configure("Muted.TLabel", background="#111c33", foreground="#94a3b8", font=("Segoe UI", 10))
        style.configure("Accent.TButton", background="#2563eb", foreground="white", padding=(14, 8), font=("Segoe UI", 10, "bold"))
        style.map("Accent.TButton", background=[("active", "#1d4ed8")])
        style.configure("Treeview", background="#111c33", fieldbackground="#111c33", foreground="#e2e8f0", rowheight=34, borderwidth=0, font=("Segoe UI", 10))
        style.configure("Treeview.Heading", background="#1e293b", foreground="#cbd5e1", relief="flat", font=("Segoe UI", 10, "bold"))
        style.map("Treeview", background=[("selected", "#1d4ed8")], foreground=[("selected", "white")])

    def build_ui(self):
        root = ttk.Frame(self, style="Root.TFrame", padding=24)
        root.pack(fill="both", expand=True)
        ttk.Label(root, text="Court Capture", style="Title.TLabel").pack(anchor="w")
        ttk.Label(root, text="自动捕获球场凭证 · 支持电脑微信和同一局域网手机", style="Sub.TLabel").pack(anchor="w", pady=(3, 18))

        top = ttk.Frame(root, style="Root.TFrame")
        top.pack(fill="x")
        self.server_badge = ttk.Label(top, text="● 服务器连接中", style="Sub.TLabel")
        self.server_badge.pack(side="left")
        ttk.Button(top, text="刷新球场", command=self.load_venues).pack(side="right")
        ttk.Button(top, text="显示配对二维码", command=self.show_pair_qr).pack(side="right", padx=(0, 8))

        list_card = ttk.Frame(root, style="Card.TFrame", padding=14)
        list_card.pack(fill="both", expand=True, pady=(14, 12))
        ttk.Label(list_card, text="球场状态", style="CardTitle.TLabel").pack(anchor="w", pady=(0, 10))
        columns = ("venue", "status", "detail", "capture")
        self.tree = ttk.Treeview(list_card, columns=columns, show="headings", selectmode="browse")
        headings = {"venue": "球场", "status": "状态", "detail": "登录信息", "capture": "捕获规则"}
        widths = {"venue": 230, "status": 90, "detail": 300, "capture": 180}
        for col in columns:
            self.tree.heading(col, text=headings[col])
            self.tree.column(col, width=widths[col], anchor="w")
        self.tree.pack(fill="both", expand=True)
        self.tree.bind("<<TreeviewSelect>>", self.on_select)

        bottom = ttk.Frame(root, style="Root.TFrame")
        bottom.pack(fill="x")
        info = ttk.Frame(bottom, style="Card.TFrame", padding=14)
        info.pack(side="left", fill="x", expand=True)
        ttk.Label(info, textvariable=self.status_text, style="CardText.TLabel").pack(anchor="w")
        ttk.Label(info, textvariable=self.network_text, style="CardText.TLabel").pack(anchor="w", pady=(5, 0))
        ttk.Label(info, textvariable=self.capture_text, style="Good.TLabel").pack(anchor="w", pady=(5, 0))
        self.action = ttk.Button(bottom, text="开始监听", style="Accent.TButton", command=self.toggle_capture)
        self.action.pack(side="right", padx=(14, 0), pady=8)

        log_card = ttk.Frame(root, style="Card.TFrame", padding=10)
        log_card.pack(fill="x", pady=(12, 0))
        self.log_text = tk.Text(log_card, height=5, bg="#0b1220", fg="#94a3b8", insertbackground="white", relief="flat", state="disabled", font=("Consolas", 9))
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
        ttk.Label(window, text="请用 Chai 小程序设置页扫码配对").pack(pady=(0, 20))
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
                if item.get("kind") == "discovery":
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
