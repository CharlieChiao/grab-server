import io
import json
import queue
import sys
import threading
from datetime import datetime

import qrcode
import requests
from PySide6.QtCore import QObject, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QFont, QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QDialog,
    QDialogButtonBox,
    QCheckBox,
    QLineEdit,
    QFrame,
    QGraphicsDropShadowEffect,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

try:
    from .main import (
        SERVER_URL,
        ProxyController,
        WindowsProxyManager,
        cert_path,
        create_runtime_logger,
        find_free_port,
        load_device_identity,
        local_ip,
        server_request,
        signed_headers,
    )
except ImportError:
    from main import (
        SERVER_URL,
        ProxyController,
        WindowsProxyManager,
        cert_path,
        create_runtime_logger,
        find_free_port,
        load_device_identity,
        local_ip,
        server_request,
        signed_headers,
    )

BRAND = "#C00038"
BRAND_DARK = "#9E002E"
BG = "#F4F5F7"
CARD = "#FFFFFF"
TEXT = "#1A1A1A"
TEXT_2 = "#6B6B70"
TEXT_3 = "#9A9AA0"
LINE = "#ECECEF"
OK = "#34C759"
ERR = "#FF3B30"


class Bridge(QObject):
    log = Signal(str)
    venues = Signal(object)
    server_error = Signal(str)
    ready = Signal(str, object)
    logo = Signal(str, bytes)
    capture_status = Signal(str)
    discovery_count = Signal(str, int)
    discovery_finished = Signal(object)
    generic_error = Signal(str, str)
    pairing = Signal(object)
    discovery_candidate = Signal(object)


class StatusDot(QLabel):
    def __init__(self, color="#C7C7CC", parent=None):
        super().__init__(parent)
        self.setFixedSize(14, 14)
        self.set_color(color)

    def set_color(self, color):
        self.setStyleSheet(f"background:{color}; border-radius:7px;")


def format_timestamp(value):
    if not value: return "暂无"
    try: return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone().strftime("%m-%d %H:%M")
    except (ValueError, TypeError): return str(value)


class VenueCard(QFrame):
    clicked = Signal(str)

    def __init__(self, venue, parent=None):
        super().__init__(parent)
        self.venue = venue
        self.venue_id = venue.get("id", "")
        self.selected = False
        self.setObjectName("venueCard")
        self.setCursor(Qt.PointingHandCursor)
        self.setMinimumHeight(116)
        self.setProperty("selected", False)
        shadow = QGraphicsDropShadowEffect(self)
        shadow.setBlurRadius(20)
        shadow.setOffset(0, 4)
        shadow.setColor(QColor(0, 0, 0, 18))
        self.setGraphicsEffect(shadow)

        root = QVBoxLayout(self)
        root.setContentsMargins(20, 18, 20, 16)
        root.setSpacing(13)
        top = QHBoxLayout()
        top.setSpacing(14)
        self.logo = QLabel("🎾")
        self.logo.setAlignment(Qt.AlignCenter)
        self.logo.setFixedSize(54, 54)
        self.logo.setStyleSheet("background:#F2F3F5;border-radius:14px;font-size:24px;")
        top.addWidget(self.logo)
        copy = QVBoxLayout()
        copy.setSpacing(4)
        name = QLabel(venue.get("name") or self.venue_id)
        name.setObjectName("venueName")
        desc = QLabel(venue.get("desc") or "球场服务")
        desc.setObjectName("muted")
        desc.setWordWrap(False)
        self.refreshed = QLabel("\u51ed\u8bc1\u5237\u65b0\uff1a\u6682\u65e0")
        self.refreshed.setObjectName("muted")
        copy.addWidget(name)
        copy.addWidget(desc)
        copy.addWidget(self.refreshed)
        top.addLayout(copy, 1)
        self.chevron = QLabel("›")
        self.chevron.setObjectName("chevron")
        top.addWidget(self.chevron)
        root.addLayout(top)

        foot = QHBoxLayout()
        foot.setSpacing(9)
        self.dot = StatusDot()
        self.status = QLabel("检测中…")
        self.status.setObjectName("statusText")
        self.capture = QLabel(", ".join(((venue.get("raw") or {}).get("capture") or {}).get("hosts", [])) or "未配置监听域名")
        self.capture.setObjectName("muted")
        self.capture.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        foot.addWidget(self.dot)
        foot.addWidget(self.status)
        foot.addStretch(1)
        foot.addWidget(self.capture)
        root.addLayout(foot)

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self.clicked.emit(self.venue_id)
        super().mousePressEvent(event)

    def set_selected(self, selected):
        self.selected = selected
        self.setProperty("selected", selected)
        self.style().unpolish(self)
        self.style().polish(self)

    def set_ready(self, data):
        ok = bool(data.get("ok"))
        self.dot.set_color(OK if ok else ERR)
        detail = data.get("detail") or ("凭证有效" if ok else "凭证失效")
        self.status.setText(("凭证有效 · " if ok else "凭证失效 · ") + detail)
        self.status.setStyleSheet(f"color:{OK if ok else ERR};font-weight:600;")
        self.refreshed.setText("\u51ed\u8bc1\u5237\u65b0\uff1a" + format_timestamp(data.get("credentialUpdatedAt")))

    def set_logo(self, content):
        pixmap = QPixmap()
        if pixmap.loadFromData(content):
            self.logo.setText("")
            self.logo.setPixmap(pixmap.scaled(54, 54, Qt.KeepAspectRatioByExpanding, Qt.SmoothTransformation))


class DiscoveryDialog(QDialog):
    stage_selected = Signal(str, str)
    finalize_requested = Signal()
    cancel_requested = Signal()
    candidate_changed = Signal(int, bool, str, str, str)
    candidates_confirmed = Signal()

    STAGES = [
        ("account", "1", "\u8d26\u6237\u9a8c\u8bc1", "\u6253\u5f00\u76ee\u6807\u5c0f\u7a0b\u5e8f\u7684\u201c\u6211\u7684\u3001\u4f59\u989d\u6216\u4f1a\u5458\u201d\u9875\u9762"),
        ("courts", "2", "\u573a\u5730\u5217\u8868", "\u6253\u5f00\u9879\u76ee\u3001\u573a\u9986\u6216\u573a\u5730\u9009\u62e9\u9875\u9762"),
        ("slots", "3", "\u65f6\u6bb5\u4ef7\u683c", "\u9009\u62e9\u65e5\u671f\uff0c\u6253\u5f00\u53ef\u9884\u7ea6\u65f6\u6bb5\u548c\u4ef7\u683c\u9875\u9762"),
        ("booking", "4", "\u751f\u6210\u8ba2\u5355", "\u64cd\u4f5c\u5230\u51fa\u73b0\u4ed8\u6b3e\u9875\uff0c\u7136\u540e\u7acb\u5373\u505c\u4e0b"),
    ]

    def __init__(self, venue_name, parent=None):
        super().__init__(parent)
        self.setWindowTitle("\u65b0\u7403\u573a\u53d1\u73b0")
        self.setMinimumSize(720, 760)
        self.setModal(False)
        self.stage = "account"
        self.candidate_cards = {}
        root = QVBoxLayout(self)
        root.setContentsMargins(28, 26, 28, 24)
        root.setSpacing(12)
        title = QLabel("\u53d1\u73b0\u65b0\u7403\u573a")
        title.setObjectName("dialogTitle")
        subtitle = QLabel(f"{venue_name} \u00b7 \u5148\u4ece\u4f1a\u8bdd\u4fe1\u606f\u4e2d\u786e\u8ba4\u5019\u9009\uff0c\u518d\u6309\u6b65\u9aa4\u5b8c\u6574\u8d70\u8ba2\u573a\u6d41\u7a0b")
        subtitle.setObjectName("muted")
        root.addWidget(title)
        root.addWidget(subtitle)
        warning = QLabel("\u5b89\u5168\u63d0\u793a\uff1a\u4e0d\u8981\u8f93\u5165\u652f\u4ed8\u5bc6\u7801\uff0c\u4e5f\u4e0d\u8981\u786e\u8ba4\u5fae\u4fe1\u652f\u4ed8\u3002\u6700\u540e\u4e00\u6b65\u53ea\u5230\u51fa\u73b0\u4ed8\u6b3e\u9875\uff1b\u652f\u4ed8\u76f8\u5173\u5185\u5bb9\u4f1a\u88ab\u81ea\u52a8\u4e22\u5f03\u3002")
        warning.setObjectName("warningBox")
        warning.setWordWrap(True)
        root.addWidget(warning)
        self.current = QLabel("\u5f53\u524d\u9636\u6bb5\uff1a1. \u8d26\u6237\u9a8c\u8bc1")
        self.current.setObjectName("sectionTitle")
        self.counter = QLabel("\u5df2\u6574\u7406 0 \u6761\u4f1a\u8bdd\u4fe1\u606f")
        self.counter.setObjectName("muted")
        root.addWidget(self.current)
        root.addWidget(self.counter)
        candidate_title = QLabel("\u5019\u9009\u4f1a\u8bdd\u4fe1\u606f")
        candidate_title.setObjectName("sectionTitle")
        self.candidate_hint = QLabel("\u5217\u8868\u6682\u65f6\u4e3a\u7a7a\uff1b\u64cd\u4f5c\u76ee\u6807\u5c0f\u7a0b\u5e8f\u540e\uff0c\u4f1a\u6309\u7403\u573a\u540d\u6587\u5b57\u5339\u914d\u548c\u540c\u57df\u5173\u8054\u5ea6\u6392\u5e8f\u51fa\u73b0\u3002")
        self.candidate_hint.setObjectName("muted")
        self.candidate_hint.setWordWrap(True)
        root.addWidget(candidate_title)
        root.addWidget(self.candidate_hint)
        self.candidate_scroll = QScrollArea()
        self.candidate_scroll.setWidgetResizable(True)
        self.candidate_scroll.setMinimumHeight(180)
        self.candidate_holder = QWidget()
        self.candidate_layout = QVBoxLayout(self.candidate_holder)
        self.candidate_layout.setContentsMargins(2, 2, 2, 2)
        self.candidate_layout.setSpacing(8)
        self.candidate_layout.addStretch(1)
        self.candidate_scroll.setWidget(self.candidate_holder)
        root.addWidget(self.candidate_scroll)
        confirm = QPushButton("\u786e\u8ba4\u5019\u9009\uff0c\u5f00\u59cb\u5b8c\u6574\u8ba2\u573a\u6d41\u7a0b")
        confirm.setObjectName("secondaryButton")
        confirm.clicked.connect(self.confirm_candidates)
        root.addWidget(confirm)
        for key, number, label, instruction in self.STAGES:
            card = QFrame()
            card.setObjectName("stepCard")
            row = QHBoxLayout(card)
            row.setContentsMargins(16, 10, 16, 10)
            number_label = QLabel(number)
            number_label.setObjectName("stepNumber")
            number_label.setFixedSize(30, 30)
            number_label.setAlignment(Qt.AlignCenter)
            row.addWidget(number_label)
            copy = QVBoxLayout()
            copy.setSpacing(2)
            step_title = QLabel(label)
            step_title.setObjectName("stepTitle")
            step_subtitle = QLabel(instruction)
            step_subtitle.setObjectName("muted")
            copy.addWidget(step_title)
            copy.addWidget(step_subtitle)
            row.addLayout(copy, 1)
            button = QPushButton("\u5207\u6362")
            button.setObjectName("secondaryButton")
            button.clicked.connect(lambda _=False, k=key, l=f"{number}. {label}": self.select_stage(k, l))
            row.addWidget(button)
            root.addWidget(card)
        actions = QHBoxLayout()
        cancel = QPushButton("\u53d6\u6d88\u53d1\u73b0")
        cancel.setObjectName("secondaryButton")
        finish = QPushButton("\u5b8c\u6210\u5e76\u751f\u6210\u8349\u7a3f")
        finish.setObjectName("primaryButton")
        cancel.clicked.connect(self.cancel_requested.emit)
        finish.clicked.connect(self.finalize_requested.emit)
        actions.addWidget(cancel)
        actions.addStretch(1)
        actions.addWidget(finish)
        root.addLayout(actions)

    def add_candidate(self, item):
        event_id = int(item.get("eventId") or 0)
        if not event_id or event_id in self.candidate_cards:
            return
        endpoint = item.get("endpoint") or {}
        relevance = item.get("candidate") or {}
        selected = bool(relevance.get("nameMatched"))
        card = QFrame()
        card.setObjectName("stepCard")
        layout = QVBoxLayout(card)
        layout.setContentsMargins(14, 11, 14, 11)
        layout.setSpacing(6)
        top = QHBoxLayout()
        checkbox = QCheckBox("\u7eb3\u5165\u8349\u7a3f")
        checkbox.setChecked(selected)
        top.addWidget(checkbox)
        top.addStretch(1)
        score = QLabel(f"\u76f8\u5173\u5ea6 {relevance.get('score', 0)}")
        score.setObjectName("muted")
        top.addWidget(score)
        layout.addLayout(top)
        path = QLabel(f"{endpoint.get('method', 'GET')}  {endpoint.get('baseUrl', '')}{endpoint.get('path', '')}")
        path.setObjectName("stepTitle")
        path.setWordWrap(True)
        layout.addWidget(path)
        context = []
        if relevance.get("nameMatched"): context.append("\u7403\u573a\u540d\u6587\u5b57\u5339\u914d")
        if relevance.get("domainCount"): context.append(f"\u540c\u57df\u5173\u8054 {relevance.get('domainCount')} \u6761")
        context_label = QLabel(" \u00b7 ".join(context) or "\u5f85\u4f60\u786e\u8ba4")
        context_label.setObjectName("muted")
        layout.addWidget(context_label)
        label_input = QLineEdit()
        label_input.setPlaceholderText("\u81ea\u5b9a\u4e49\u540d\u79f0\uff08\u4f8b\uff1a\u65f6\u6bb5\u67e5\u8be2\uff09")
        tags_input = QLineEdit()
        tags_input.setPlaceholderText("\u6807\u7b7e\uff0c\u7528\u9017\u53f7\u5206\u9694\uff08\u4f8b\uff1aslots, price\uff09")
        note_input = QLineEdit()
        note_input.setPlaceholderText("\u5907\u6ce8\uff08\u9009\u586b\uff09")
        layout.addWidget(label_input)
        layout.addWidget(tags_input)
        layout.addWidget(note_input)
        def save():
            self.candidate_changed.emit(event_id, checkbox.isChecked(), label_input.text(), tags_input.text(), note_input.text())
        checkbox.toggled.connect(lambda _checked: save())
        label_input.editingFinished.connect(save)
        tags_input.editingFinished.connect(save)
        note_input.editingFinished.connect(save)
        insert_at = 0
        score_value = int(relevance.get("score") or 0)
        for other_id, other in self.candidate_cards.items():
            if score_value > other["score"]:
                break
            insert_at += 1
        self.candidate_layout.insertWidget(insert_at, card)
        self.candidate_cards[event_id] = {"card": card, "score": score_value}
        self.candidate_hint.setText("\u5df2\u51fa\u73b0\u5019\u9009\u4f1a\u8bdd\u4fe1\u606f\u3002\u53ef\u52fe\u9009\u7eb3\u5165\u8349\u7a3f\uff0c\u5e76\u4e3a\u540e\u7eed\u914d\u7f6e\u586b\u5199\u540d\u79f0\u3001\u6807\u7b7e\u548c\u5907\u6ce8\u3002")

    def confirm_candidates(self):
        self.candidates_confirmed.emit()
        self.candidate_hint.setText("\u5019\u9009\u5df2\u786e\u8ba4\u3002\u73b0\u5728\u8bf7\u4f9d\u6b21\u5207\u6362\u4e0b\u65b9\u9636\u6bb5\uff0c\u5b8c\u6574\u8d70\u5230\u4ed8\u6b3e\u9875\u4e4b\u524d\u5373\u53ef\u3002")

    def select_stage(self, key, label):
        self.stage_selected.emit(key, label)

    def closeEvent(self, event):
        self.cancel_requested.emit()
        event.ignore()

    def set_count(self, stage, count):
        if stage == self.stage:
            self.counter.setText(f"\u5df2\u6574\u7406 {count} \u6761\u4f1a\u8bdd\u4fe1\u606f")


class CaptureWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Court Capture")
        self.resize(1020, 760)
        self.setMinimumSize(900, 680)
        self.events = queue.Queue()
        self.bridge = Bridge()
        self.device_identity = load_device_identity()
        self.venues = []
        self.cards = {}
        self.selected_venue = None
        self.controller = None
        self.system_proxy = WindowsProxyManager()
        self.runtime_logger = create_runtime_logger()
        self.runtime_logger.info("application started")
        self.pair_status = None
        self.port = None
        self.discovery_session = None
        self.discovery_config = None
        self.discovery_dialog = None
        self.discovery_counts = {"account": 0, "courts": 0, "slots": 0, "booking": 0}
        self.discovery_uploads = 0
        self.traffic_count = 0
        self.build_ui()
        self.connect_signals()
        self.poll_timer = QTimer(self)
        self.poll_timer.timeout.connect(self.poll_events)
        self.poll_timer.start(180)
        QTimer.singleShot(300, self.load_venues)

    def connect_signals(self):
        self.bridge.log.connect(self.write_log)
        self.bridge.venues.connect(self.apply_venues)
        self.bridge.server_error.connect(self.server_error)
        self.bridge.ready.connect(self.apply_ready)
        self.bridge.logo.connect(self.apply_logo)
        self.bridge.capture_status.connect(self.capture_label.setText)
        self.bridge.discovery_count.connect(self.apply_discovery_count)
        self.bridge.discovery_finished.connect(self.apply_discovery_finished)
        self.bridge.generic_error.connect(lambda title, detail: QMessageBox.critical(self, title, detail))
        self.bridge.pairing.connect(self.apply_pairing)
        self.bridge.discovery_candidate.connect(self.add_discovery_candidate)

    def card(self, object_name=None):
        frame = QFrame()
        frame.setObjectName(object_name or "card")
        shadow = QGraphicsDropShadowEffect(frame)
        shadow.setBlurRadius(24)
        shadow.setOffset(0, 5)
        shadow.setColor(QColor(0, 0, 0, 16))
        frame.setGraphicsEffect(shadow)
        return frame

    def build_ui(self):
        central = QWidget()
        central.setObjectName("appRoot")
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(26, 24, 26, 24)
        root.setSpacing(16)

        hero = QFrame()
        hero.setObjectName("hero")
        hero.setMinimumHeight(112)
        hero_layout = QHBoxLayout(hero)
        hero_layout.setContentsMargins(28, 22, 28, 22)
        hero_copy = QVBoxLayout()
        hero_copy.setSpacing(5)
        title = QLabel("Court Capture")
        title.setObjectName("heroTitle")
        subtitle = QLabel("球场凭证、新球场发现与安全注册")
        subtitle.setObjectName("heroSubtitle")
        hero_copy.addWidget(title)
        hero_copy.addWidget(subtitle)
        hero_layout.addLayout(hero_copy, 1)
        self.server_badge = QLabel("● 服务器连接中")
        self.server_badge.setObjectName("heroBadge")
        hero_layout.addWidget(self.server_badge, 0, Qt.AlignTop)
        root.addWidget(hero)

        toolbar = self.card()
        toolbar_layout = QHBoxLayout(toolbar)
        toolbar_layout.setContentsMargins(20, 14, 20, 14)
        toolbar_title = QLabel("球场与设备")
        toolbar_title.setObjectName("sectionTitle")
        toolbar_layout.addWidget(toolbar_title)
        toolbar_layout.addStretch(1)
        discover = QPushButton("＋ 发现新球场")
        discover.setObjectName("primaryButton")
        discover.clicked.connect(self.start_discovery)
        self.pair_badge = QLabel("\u25cf \u914d\u5bf9\u72b6\u6001\u68c0\u67e5\u4e2d")
        self.pair_badge.setObjectName("statusText")
        self.pair_button = QPushButton("\u663e\u793a\u914d\u5bf9\u4e8c\u7ef4\u7801")
        self.pair_button.setObjectName("secondaryButton")
        self.pair_button.clicked.connect(self.show_pair_qr)
        refresh = QPushButton("刷新")
        refresh.setObjectName("secondaryButton")
        refresh.clicked.connect(self.load_venues)
        toolbar_layout.addWidget(discover)
        toolbar_layout.addWidget(self.pair_badge)
        toolbar_layout.addWidget(self.pair_button)
        toolbar_layout.addWidget(refresh)
        root.addWidget(toolbar)

        content = QHBoxLayout()
        content.setSpacing(16)
        venues_card = self.card()
        venues_layout = QVBoxLayout(venues_card)
        venues_layout.setContentsMargins(20, 18, 20, 18)
        venues_layout.setSpacing(12)
        heading = QHBoxLayout()
        heading_label = QLabel("球场状态")
        heading_label.setObjectName("sectionTitle")
        hint = QLabel("选择球场后开始监听")
        hint.setObjectName("muted")
        heading.addWidget(heading_label)
        heading.addStretch(1)
        heading.addWidget(hint)
        venues_layout.addLayout(heading)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)
        scroll.setObjectName("venueScroll")
        self.venue_holder = QWidget()
        self.venue_layout = QVBoxLayout(self.venue_holder)
        self.venue_layout.setContentsMargins(1, 1, 10, 1)
        self.venue_layout.setSpacing(12)
        self.venue_layout.addStretch(1)
        scroll.setWidget(self.venue_holder)
        venues_layout.addWidget(scroll, 1)
        content.addWidget(venues_card, 3)

        side = QVBoxLayout()
        side.setSpacing(16)
        control = self.card()
        control_layout = QVBoxLayout(control)
        control_layout.setContentsMargins(20, 20, 20, 20)
        control_layout.setSpacing(10)
        control_title = QLabel("监听控制")
        control_title.setObjectName("sectionTitle")
        self.status_label = QLabel("正在连接服务器…")
        self.status_label.setObjectName("bodyText")
        self.network_label = QLabel("选择一个球场后开始")
        self.network_label.setObjectName("muted")
        self.network_label.setWordWrap(True)
        self.capture_label = QLabel("等待开始监听")
        self.capture_label.setObjectName("successText")
        self.capture_label.setWordWrap(True)
        self.action = QPushButton("开始监听")
        self.action.setObjectName("primaryButton")
        self.action.setMinimumHeight(44)
        self.action.clicked.connect(self.toggle_capture)
        control_layout.addWidget(control_title)
        control_layout.addWidget(self.status_label)
        control_layout.addWidget(self.network_label)
        control_layout.addWidget(self.capture_label)
        control_layout.addSpacing(8)
        control_layout.addWidget(self.action)
        side.addWidget(control)

        tasks_card = self.card()
        tasks_layout = QVBoxLayout(tasks_card)
        tasks_layout.setContentsMargins(20, 18, 20, 18)
        tasks_title = QLabel("采集任务")
        tasks_title.setObjectName("sectionTitle")
        self.tasks_label = QLabel("选择球场后显示采集清单")
        self.tasks_label.setObjectName("bodyText")
        self.tasks_label.setWordWrap(True)
        tasks_layout.addWidget(tasks_title)
        tasks_layout.addWidget(self.tasks_label)
        side.addWidget(tasks_card)

        log_card = self.card()
        log_layout = QVBoxLayout(log_card)
        log_layout.setContentsMargins(20, 18, 20, 18)
        log_title = QLabel("运行记录")
        log_title.setObjectName("sectionTitle")
        self.log_label = QLabel("等待操作…")
        self.log_label.setObjectName("logText")
        self.log_label.setWordWrap(True)
        self.log_label.setAlignment(Qt.AlignTop | Qt.AlignLeft)
        self.log_label.setMinimumHeight(180)
        log_layout.addWidget(log_title)
        log_layout.addWidget(self.log_label, 1)
        side.addWidget(log_card, 1)
        content.addLayout(side, 2)
        root.addLayout(content, 1)

    def load_venues(self):
        self.server_badge.setText("● 正在连接")
        self.fetch_pairing_status()
        def worker():
            try:
                response = server_request("GET", SERVER_URL.rstrip("/") + "/api/venues", timeout=12)
                response.raise_for_status()
                self.bridge.venues.emit(response.json().get("venues", []))
            except Exception as exc:
                self.bridge.server_error.emit(str(exc))
        threading.Thread(target=worker, daemon=True).start()

    def fetch_pairing_status(self):
        def worker():
            payload = {}
            try:
                response = server_request("GET", SERVER_URL.rstrip("/") + "/api/devices/me", headers=signed_headers(self.device_identity, payload), timeout=12)
                if response.status_code in (401, 403):
                    self.bridge.pairing.emit({"paired": False, "detail": "\u672a\u914d\u5bf9"})
                    return
                response.raise_for_status()
                self.bridge.pairing.emit(response.json())
            except Exception as exc:
                self.bridge.pairing.emit({"paired": None, "detail": str(exc)})
        threading.Thread(target=worker, daemon=True).start()

    def apply_pairing(self, data):
        paired = data.get("paired")
        if paired is True:
            device = data.get("device") or {}
            user = data.get("user") or {}
            owner = user.get("nickname") or "\u5df2\u914d\u5bf9\u8d26\u6237"
            self.pair_badge.setText("\u25cf \u5df2\u914d\u5bf9 \u00b7 " + owner)
            self.pair_badge.setStyleSheet(f"color:{OK};font-weight:600;")
            self.pair_button.setText("\u91cd\u65b0\u914d\u5bf9")
            self.pair_status = True
            self.write_log("\u8bbe\u5907\u5df2\u914d\u5bf9\uff1a" + (device.get("name") or "\u5f53\u524d\u7535\u8111"))
        elif paired is False:
            self.pair_badge.setText("\u25cf \u672a\u914d\u5bf9")
            self.pair_badge.setStyleSheet(f"color:{ERR};font-weight:600;")
            self.pair_button.setText("\u663e\u793a\u914d\u5bf9\u4e8c\u7ef4\u7801")
            self.pair_status = False
        else:
            self.pair_badge.setText("\u25cf \u914d\u5bf9\u72b6\u6001\u4e0d\u53ef\u7528")
            self.pair_badge.setStyleSheet("color:#FF9F0A;")
            self.pair_status = None
            self.write_log("\u914d\u5bf9\u72b6\u6001\u68c0\u67e5\u5931\u8d25\uff1a" + str(data.get("detail") or "\u672a\u77e5\u9519\u8bef"))

    def clear_venues(self):
        while self.venue_layout.count() > 1:
            item = self.venue_layout.takeAt(0)
            widget = item.widget()
            if widget:
                widget.deleteLater()

    def apply_venues(self, venues):
        self.venues = venues
        self.cards = {}
        self.clear_venues()
        self.server_badge.setText("● 服务器在线")
        self.server_badge.setStyleSheet("color:#D8F7E0;")
        for venue in venues:
            card = VenueCard(venue)
            card.clicked.connect(self.select_venue)
            self.cards[venue.get("id")] = card
            self.venue_layout.insertWidget(self.venue_layout.count() - 1, card)
            if venue.get("logo"):
                self.fetch_logo(venue.get("id"), venue.get("logo"))
        self.status_label.setText(f"已加载 {len(venues)} 个球场")
        for venue in venues:
            self.fetch_ready(venue.get("id"))

    def fetch_logo(self, venue_id, url):
        def worker():
            try:
                content = requests.get(url, timeout=10).content
                self.bridge.logo.emit(venue_id, content)
            except Exception:
                pass
        threading.Thread(target=worker, daemon=True).start()

    def apply_logo(self, venue_id, content):
        card = self.cards.get(venue_id)
        if card:
            card.set_logo(content)

    def fetch_ready(self, venue_id):
        def worker():
            try:
                payload = {}
                response = server_request("GET", SERVER_URL.rstrip("/") + "/api/ready/" + venue_id, headers=signed_headers(self.device_identity, payload), timeout=15)
                self.bridge.ready.emit(venue_id, response.json())
            except Exception as exc:
                self.bridge.ready.emit(venue_id, {"ok": False, "detail": str(exc)})
        threading.Thread(target=worker, daemon=True).start()

    def apply_ready(self, venue_id, data):
        card = self.cards.get(venue_id)
        if card:
            card.set_ready(data)
        if self.selected_venue and self.selected_venue.get("id") == venue_id:
            self.render_capture_tasks(data.get("captureTasks") or [])

    def select_venue(self, venue_id):
        self.selected_venue = next((item for item in self.venues if item.get("id") == venue_id), None)
        for current_id, card in self.cards.items():
            card.set_selected(current_id == venue_id)
        if self.selected_venue:
            name = self.selected_venue.get("name") or venue_id
            self.status_label.setText("已选择 " + name)
            self.capture_label.setText("准备监听该球场凭证")
            configured = (((self.selected_venue.get("raw") or {}).get("capture") or {}).get("tasks") or [])
            self.render_capture_tasks([{**task, "completed": False, "valid": None, "updatedAt": None} for task in configured])
            self.fetch_ready(venue_id)

    def render_capture_tasks(self, tasks):
        if not tasks:
            self.tasks_label.setText("该球场未配置采集任务")
            return
        lines = []
        for task in tasks:
            completed = bool(task.get("completed"))
            if completed and task.get("valid") is not False: icon, state = "✓", "已完成"
            elif completed: icon, state = "⚠", "已失效"
            else: icon, state = "○", "待采集"
            optional = "" if task.get("required") is not False else " · 可选"
            updated = (" · " + format_timestamp(task.get("updatedAt"))) if task.get("updatedAt") else ""
            count = (" · %s 项" % task.get("count")) if task.get("count") is not None else ""
            lines.append(f"{icon} {task.get('label') or task.get('id')}  {state}{optional}{count}{updated}")
        self.tasks_label.setText("\n".join(lines))

    def toggle_capture(self):
        if self.controller:
            self.controller.stop()
            self.controller = None
            self.system_proxy.restore()
            self.write_log("Windows proxy restored")
            self.action.setText("开始监听")
            self.network_label.setText("监听已停止")
            self.capture_label.setText("等待开始监听")
            return
        if not self.selected_venue:
            QMessageBox.information(self, "请选择球场", "请先选择一个球场。")
            return
        if not cert_path().exists():
            QMessageBox.warning(self, "需要证书", "未检测到 mitmproxy 根证书：\n\n" + str(cert_path()))
            return
        capture = ((self.selected_venue.get("raw") or {}).get("capture") or {})
        if not capture.get("hosts"):
            QMessageBox.warning(self, "捕获配置缺失", "该球场没有监听域名配置，可以使用“发现新球场”。")
            return
        self.traffic_count = 0
        self.port = find_free_port()
        self.controller = ProxyController(capture, self.events, self.bridge.log.emit)
        self.controller.start(self.port)
        self.system_proxy.enable(self.port)
        self.write_log(f"Windows proxy enabled at 127.0.0.1:{self.port}")
        self.action.setText("停止监听")
        self.network_label.setText(f"代理地址 {local_ip()}:{self.port}\n手机与电脑同一 Wi-Fi 后可使用此代理")
        self.capture_label.setText("正在监听 " + (self.selected_venue.get("name") or ""))

    def show_pair_qr(self):
        payload = {"type": "court_capture_pair", "deviceId": self.device_identity["deviceId"], "publicKey": self.device_identity["secret"], "deviceName": self.device_identity["deviceName"]}
        image = qrcode.make(json.dumps(payload, ensure_ascii=False)).resize((320, 320))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        pixmap = QPixmap()
        pixmap.loadFromData(buffer.getvalue())
        dialog = QDialog(self)
        dialog.setWindowTitle("扫码配对")
        layout = QVBoxLayout(dialog)
        layout.setContentsMargins(28, 26, 28, 26)
        title = QLabel("电脑配对")
        title.setObjectName("dialogTitle")
        subtitle = QLabel("请用 Chai 小程序“我的”页扫码")
        subtitle.setObjectName("muted")
        qr = QLabel()
        qr.setPixmap(pixmap)
        qr.setAlignment(Qt.AlignCenter)
        close = QPushButton("完成")
        close.setObjectName("primaryButton")
        close.clicked.connect(dialog.accept)
        layout.addWidget(title)
        layout.addWidget(subtitle)
        layout.addWidget(qr)
        layout.addWidget(close)
        dialog.exec()
        self.fetch_pairing_status()

    def start_discovery(self):
        if self.controller:
            QMessageBox.information(self, "监听进行中", "请先停止当前监听。")
            return
        if not cert_path().exists():
            QMessageBox.warning(self, "需要证书", "未检测到 mitmproxy 根证书：\n\n" + str(cert_path()))
            return
        venue_name, ok = QInputDialog.getText(self, "发现新球场", "球场名称")
        if not ok or not venue_name.strip():
            return
        payload = {"venueName": venue_name.strip()}
        try:
            response = server_request("POST", SERVER_URL.rstrip("/") + "/api/venue-discovery/sessions", json=payload, headers=signed_headers(self.device_identity, payload), timeout=15)
            response.raise_for_status()
            self.discovery_session = response.json()["sessionId"]
        except Exception as exc:
            detail = str(exc)
            response = getattr(exc, "response", None)
            if response is not None:
                try: detail = response.json().get("error") or detail
                except Exception: detail = response.text or detail
            self.write_log("\u65e0\u6cd5\u5f00\u59cb\u53d1\u73b0\uff1a" + detail)
            if response is not None and response.status_code in (401, 403):
                QMessageBox.critical(self, "\u9700\u8981\u914d\u5bf9", "\u8fd9\u53f0\u7535\u8111\u5c1a\u672a\u914d\u5bf9\u3002\u8bf7\u5728 Chai \u5c0f\u7a0b\u5e8f“\u6211\u7684”\u9875\u626b\u7801\u914d\u5bf9\u540e\u91cd\u8bd5\u3002\n\n" + detail)
            else:
                QMessageBox.critical(self, "\u65e0\u6cd5\u5f00\u59cb\u53d1\u73b0", detail)
            return
        self.discovery_counts = {"account": 0, "courts": 0, "slots": 0, "booking": 0}
        self.discovery_uploads = 0
        self.discovery_config = {"learningMode": True, "learningStage": "account"}
        self.port = find_free_port()
        self.controller = ProxyController(self.discovery_config, self.events, self.bridge.log.emit)
        self.controller.start(self.port)
        self.system_proxy.enable(self.port)
        self.write_log(f"Windows proxy enabled at 127.0.0.1:{self.port}")
        self.action.setText("停止监听")
        self.network_label.setText(f"发现代理 {local_ip()}:{self.port}")
        self.capture_label.setText("新球场发现 · 账户验证")
        self.discovery_dialog = DiscoveryDialog(venue_name.strip(), self)
        self.discovery_dialog.stage_selected.connect(self.set_discovery_stage)
        self.discovery_dialog.finalize_requested.connect(self.finalize_discovery)
        self.discovery_dialog.cancel_requested.connect(self.cancel_discovery)
        self.discovery_dialog.candidate_changed.connect(self.save_candidate_annotation)
        self.discovery_dialog.candidates_confirmed.connect(self.confirm_discovery_candidates)
        self.discovery_dialog.show()

    def set_discovery_stage(self, stage, label):
        if not self.discovery_config:
            return
        if stage == "booking":
            result = QMessageBox.warning(self, "生成订单阶段", "此步骤可能在目标平台生成一个未支付订单。请只操作到出现付款页，不要输入支付密码或确认支付。", QMessageBox.Ok | QMessageBox.Cancel)
            if result != QMessageBox.Ok:
                return
        self.discovery_config["learningStage"] = stage
        if self.discovery_dialog:
            self.discovery_dialog.stage = stage
            self.discovery_dialog.current.setText("当前阶段：" + label)
            self.discovery_dialog.set_count(stage, self.discovery_counts.get(stage, 0))
        self.capture_label.setText("新球场发现 · " + label)
        self.write_log("发现阶段切换为 " + label)

    def upload_learning_event(self, stage, event):
        session_id = self.discovery_session
        if not session_id:
            self.bridge.discovery_count.emit(stage, -1)
            return
        payload = {"stage": stage, "event": event}
        try:
            response = server_request("POST", SERVER_URL.rstrip("/") + f"/api/venue-discovery/sessions/{session_id}/events", json=payload, headers=signed_headers(self.device_identity, payload), timeout=20)
            if response.status_code == 422:
                self.bridge.log.emit("\u5df2\u5ffd\u7565\u652f\u4ed8\u76f8\u5173\u5185\u5bb9")
                return
            response.raise_for_status()
            result = response.json()
            self.discovery_counts[stage] = self.discovery_counts.get(stage, 0) + 1
            self.bridge.discovery_count.emit(stage, self.discovery_counts[stage])
            result["stage"] = stage
            self.bridge.discovery_candidate.emit(result)
            self.bridge.log.emit(f"[{stage}] \u5df2\u6574\u7406\u4f1a\u8bdd\u4fe1\u606f {event.get('method')} {event.get('url', '').split('?')[0]}")
        except Exception as exc:
            self.bridge.log.emit("\u53d1\u73b0\u4f1a\u8bdd\u4fe1\u606f\u4e0a\u4f20\u5931\u8d25\uff1a" + str(exc))
        finally:
            self.bridge.discovery_count.emit(stage, -1)

    def add_discovery_candidate(self, item):
        if self.discovery_dialog:
            self.discovery_dialog.add_candidate(item)

    def save_candidate_annotation(self, event_id, selected, label, tags_text, note):
        session_id = self.discovery_session
        if not session_id:
            return
        payload = {"selected": selected, "label": label, "tags": [tag.strip() for tag in tags_text.split(",") if tag.strip()], "note": note}
        def worker():
            try:
                response = server_request("POST", SERVER_URL.rstrip("/") + f"/api/venue-discovery/sessions/{session_id}/events/{event_id}/annotation", json=payload, headers=signed_headers(self.device_identity, payload), timeout=15)
                response.raise_for_status()
                self.bridge.log.emit("\u5019\u9009\u4f1a\u8bdd\u4fe1\u606f\u6807\u6ce8\u5df2\u4fdd\u5b58")
            except Exception as exc:
                self.bridge.log.emit("\u4f1a\u8bdd\u4fe1\u606f\u6807\u6ce8\u4fdd\u5b58\u5931\u8d25\uff1a" + str(exc))
        threading.Thread(target=worker, daemon=True).start()

    def confirm_discovery_candidates(self):
        self.write_log("\u5df2\u786e\u8ba4\u5019\u9009\u4f1a\u8bdd\u4fe1\u606f\uff0c\u8bf7\u7ee7\u7eed\u5b8c\u6574\u8d70\u8ba2\u573a\u6d41\u7a0b")
        self.set_discovery_stage("account", "1. \u8d26\u6237\u9a8c\u8bc1")

    def apply_discovery_count(self, stage, count):
        if count == -1:
            self.discovery_uploads = max(0, self.discovery_uploads - 1)
            return
        if self.discovery_dialog:
            self.discovery_dialog.set_count(stage, count)

    def finalize_discovery(self):
        if not self.discovery_session:
            return
        if self.discovery_uploads:
            QMessageBox.information(self, "正在整理", f"还有 {self.discovery_uploads} 条接口正在安全上传，请稍后再试。")
            return
        if self.controller:
            self.controller.stop()
            self.controller = None
            self.system_proxy.restore()
            self.write_log("Windows proxy restored")
            self.action.setText("开始监听")
        session_id = self.discovery_session
        def worker():
            payload = {}
            try:
                response = server_request("POST", SERVER_URL.rstrip("/") + f"/api/venue-discovery/sessions/{session_id}/finalize", json=payload, headers=signed_headers(self.device_identity, payload), timeout=20)
                response.raise_for_status()
                self.bridge.discovery_finished.emit(response.json().get("manifest") or {})
            except Exception as exc:
                self.bridge.generic_error.emit("生成草稿失败", str(exc))
        threading.Thread(target=worker, daemon=True).start()

    def apply_discovery_finished(self, manifest):
        missing = manifest.get("missing") or []
        if missing:
            QMessageBox.warning(self, "草稿需要补充", "以下阶段还没有可用接口：\n\n" + "、".join(missing))
        else:
            QMessageBox.information(self, "采集完成", "四类接口均已收集，服务器已生成声明式草稿。")
        self.capture_label.setText("新球场草稿已保存")
        self.discovery_session = None
        self.discovery_config = None
        if self.discovery_dialog:
            self.discovery_dialog.accept()
            self.discovery_dialog = None

    def cancel_discovery(self):
        if self.controller:
            self.controller.stop()
            self.controller = None
            self.system_proxy.restore()
            self.write_log("Windows proxy restored")
            self.action.setText("开始监听")
        session_id = self.discovery_session
        self.discovery_session = None
        self.discovery_config = None
        if self.discovery_dialog:
            self.discovery_dialog.reject()
            self.discovery_dialog = None
        self.capture_label.setText("新球场发现已取消")
        if session_id:
            def worker():
                try:
                    payload = {}
                    server_request("DELETE", SERVER_URL.rstrip("/") + f"/api/venue-discovery/sessions/{session_id}", json=payload, headers=signed_headers(self.device_identity, payload), timeout=15)
                except Exception as exc:
                    self.bridge.log.emit("清理发现会话失败：" + str(exc))
            threading.Thread(target=worker, daemon=True).start()

    def poll_events(self):
        try:
            while True:
                item = self.events.get_nowait()
                kind = item.get("kind")
                if kind == "traffic":
                    self.traffic_count += 1
                    self.network_label.setText(f"代理流量正常 · 已检测到 {self.traffic_count} 个接口")
                    self.capture_label.setText("已检测到球场流量，正在等待凭证请求")
                    if self.traffic_count <= 8:
                        self.write_log("检测到：" + item.get("host", "") + item.get("path", ""))
                elif kind == "learning":
                    stage = item.get("stage") or "account"
                    self.discovery_uploads += 1
                    threading.Thread(target=self.upload_learning_event, args=(stage, item.get("event") or {}), daemon=True).start()
                elif kind == "discovery":
                    threading.Thread(target=self.upload_discovered_courts, args=(item.get("courts") or [],), daemon=True).start()
                elif kind == "credential":
                    threading.Thread(target=self.upload_credential, args=(item,), daemon=True).start()
        except queue.Empty:
            pass

    def upload_credential(self, item):
        if not self.selected_venue:
            return
        capture = ((self.selected_venue.get("raw") or {}).get("capture") or {})
        header_name = (capture.get("headers") or ["PSPLVISITORID"])[0]
        value = (item.get("headers") or {}).get(header_name)
        if not value:
            return
        venue_id = self.selected_venue.get("id")
        self.bridge.log.emit("已匹配凭证请求：" + item.get("host", "") + item.get("path", ""))
        payload = {"text": value}
        try:
            response = server_request("POST", SERVER_URL.rstrip("/") + f"/api/credentials/{venue_id}/ingest", json=payload, headers=signed_headers(self.device_identity, payload), timeout=15)
            response.raise_for_status()
            result = response.json()
            self.bridge.capture_status.emit("上传完成 · ready=" + str(result.get("ready")))
            self.bridge.log.emit("凭证已上传并完成服务器验证")
            self.fetch_ready(venue_id)
        except Exception as exc:
            self.bridge.log.emit("凭证上传失败：" + str(exc))

    def upload_discovered_courts(self, courts):
        if not self.selected_venue:
            return
        venue_id = self.selected_venue.get("id")
        payload = {"courts": courts}
        try:
            response = server_request("POST", SERVER_URL.rstrip("/") + f"/api/venues/{venue_id}/discover-capture", json=payload, headers=signed_headers(self.device_identity, payload), timeout=20)
            response.raise_for_status()
            self.bridge.capture_status.emit(f"球场信息已上传 · {len(response.json().get('discovered', []))} 个场地")
        except Exception as exc:
            self.bridge.log.emit("球场信息上传失败：" + str(exc))

    def server_error(self, error):
        self.server_badge.setText("● 连接失败")
        self.server_badge.setStyleSheet("color:#FFD5D2;")
        self.status_label.setText("无法读取球场列表")
        self.write_log(error)

    def write_log(self, message):
        self.runtime_logger.info(str(message))
        current = self.log_label.text().splitlines()
        if current == ["等待操作…"]:
            current = []
        current.append(message)
        self.log_label.setText("\n".join(current[-9:]))

    def closeEvent(self, event):
        self.shutdown()
        event.accept()

    def shutdown(self):
        self.runtime_logger.info("application shutting down")
        self.poll_timer.stop()
        controller = self.controller
        self.controller = None
        if controller:
            controller.stop()
        self.system_proxy.restore()


STYLESHEET = f"""
QWidget#appRoot {{ background: {BG}; color: {TEXT}; font-family: 'Microsoft YaHei UI'; font-size: 13px; }}
QFrame#hero {{ background: {BRAND}; border-radius: 22px; }}
QLabel#heroTitle {{ color: white; font-size: 27px; font-weight: 700; }}
QLabel#heroSubtitle {{ color: #F8DDE5; font-size: 13px; }}
QLabel#heroBadge {{ color: #F8DDE5; font-weight: 600; }}
QFrame#card, QFrame#venueCard, QFrame#stepCard {{ background: {CARD}; border: 1px solid {LINE}; border-radius: 18px; }}
QFrame#venueCard[selected='true'] {{ border: 2px solid {BRAND}; background: #FFF8FA; }}
QLabel#venueName, QLabel#sectionTitle, QLabel#stepTitle {{ color: {TEXT}; font-size: 15px; font-weight: 700; }}
QLabel#dialogTitle {{ color: {TEXT}; font-size: 23px; font-weight: 700; }}
QLabel#muted {{ color: {TEXT_3}; font-size: 12px; }}
QLabel#bodyText {{ color: {TEXT_2}; font-size: 13px; }}
QLabel#successText {{ color: {OK}; font-size: 13px; font-weight: 600; }}
QLabel#statusText {{ color: {TEXT_2}; font-size: 12px; }}
QLabel#chevron {{ color: #B1B1B6; font-size: 28px; }}
QLabel#logText {{ color: {TEXT_2}; background: #FAFAFB; border-radius: 12px; padding: 12px; font-family: Consolas; font-size: 11px; }}
QLabel#warningBox {{ color: #B42318; background: #FFF1F0; border: 1px solid #FFD5D2; border-radius: 12px; padding: 13px; }}
QLabel#stepNumber {{ color: white; background: {BRAND}; border-radius: 16px; font-weight: 700; }}
QPushButton {{ border: none; border-radius: 11px; min-height: 36px; padding: 0 16px; font-weight: 600; }}
QPushButton#primaryButton {{ color: white; background: {BRAND}; }}
QPushButton#primaryButton:hover {{ background: {BRAND_DARK}; }}
QPushButton#primaryButton:pressed {{ background: #870027; }}
QPushButton#secondaryButton {{ color: {TEXT_2}; background: white; border: 1px solid #E1E1E6; }}
QPushButton#secondaryButton:hover {{ color: {BRAND}; background: #FFF8FA; border-color: #E9A9BC; }}
QScrollArea#venueScroll {{ background: transparent; border: none; }}
QScrollArea#venueScroll > QWidget > QWidget {{ background: transparent; }}
QDialog {{ background: {BG}; color: {TEXT}; font-family: 'Microsoft YaHei UI'; }}
QInputDialog {{ background: {BG}; }}
QLineEdit {{ min-height: 38px; border: 1px solid #D8D8DC; border-radius: 10px; padding: 0 12px; background: white; }}
QScrollBar:vertical {{ background: transparent; width: 8px; margin: 0; }}
QScrollBar::handle:vertical {{ background: #CFCFD4; border-radius: 4px; min-height: 32px; }}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
"""


def main():
    app = QApplication(sys.argv)
    app.setApplicationName("Court Capture")
    app.setFont(QFont("Microsoft YaHei UI", 10))
    app.setStyleSheet(STYLESHEET)
    window = CaptureWindow()
    app.aboutToQuit.connect(window.shutdown)
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())