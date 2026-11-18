// 报刊回声 · 悬浮按钮
// 与书信簿（st-epistolary，MIT）的悬浮按钮同一款式：深炭灰扁平圆钮、浅香槟金细环、单色图标，
// 只把信封换成一份折起的报纸，一眼能看出是同一系列。
// 点一下打开 / 收起面板；按住拖动可以挪到屏幕任何地方（位置会记住）。

const SIZE = 54;
const DRAG_THRESHOLD = 5;

// 实心的几何报纸：纸面 + 刻出来的报头、栏线和图片块
const ICON = `
<svg class="pe-fab-icon" viewBox="4.4 7.4 23.2 18.2" aria-hidden="true">
    <path class="pe-fab-paper" d="M8.2 8h16.3A1.5 1.5 0 0 1 26 9.5v12.3a2.2 2.2 0 0 1-2.2 2.2H7.6A2.6 2.6 0 0 1 5 21.4V12.4h3.2V8z"/>
    <path class="pe-fab-cut" d="M8.2 12.4v9.1a1.25 1.25 0 0 1-2.5 0" fill="none" stroke-width="1.1" stroke-linecap="round"/>
    <path class="pe-fab-cut" d="M10.6 11.2h12.6" fill="none" stroke-width="2.1" stroke-linecap="round"/>
    <path class="pe-fab-cut" d="M10.6 15.2h5.2M10.6 17.8h5.2M10.6 20.4h5.2" fill="none" stroke-width="1.1" stroke-linecap="round"/>
    <rect class="pe-fab-cut-fill" x="17.6" y="14.4" width="5.6" height="6.8" rx=".6"/>
</svg>`;

export class Fab {
    // getPos / setPos：读写保存的位置 { right, bottom }（离右下角的距离，窗口大小变了也不会跑出屏幕）
    constructor({ onClick, getPos, setPos, title = '报刊回声' }) {
        this.onClick = onClick;
        this.getPos = getPos;
        this.setPos = setPos;
        const el = document.createElement('button');
        el.type = 'button';
        el.id = 'pe-fab';
        el.className = 'pe-fab';
        el.title = title;
        el.setAttribute('aria-label', title);
        el.innerHTML = `<span class="pe-fab-face">${ICON}</span><span class="pe-fab-badge" hidden></span>`;
        this.el = el;
        this.badge = el.querySelector('.pe-fab-badge');
        document.body.appendChild(el);
        this.place(this.getPos?.() || null);
        this.bindDrag();
        this.onResize = () => this.place(this.current);
        window.addEventListener('resize', this.onResize);
    }

    // 放到 { right, bottom } 处，夹在屏幕里。默认在书信簿按钮（bottom 120）上方，不重叠
    place(pos) {
        const vw = window.innerWidth, vh = window.innerHeight;
        const size = this.el.offsetWidth || SIZE;
        const right = Math.min(Math.max(8, pos?.right ?? 24), Math.max(8, vw - size - 8));
        const bottom = Math.min(Math.max(8, pos?.bottom ?? 190), Math.max(8, vh - size - 8));
        this.current = { right, bottom };
        this.el.style.right = `${right}px`;
        this.el.style.bottom = `${bottom}px`;
    }

    bindDrag() {
        let start = null;
        const down = e => {
            if (e.button != null && e.button !== 0) return;
            start = { x: e.clientX, y: e.clientY, right: this.current.right, bottom: this.current.bottom, moved: false };
            this.el.setPointerCapture?.(e.pointerId);
            this.el.classList.add('pressed');
        };
        const move = e => {
            if (!start) return;
            const dx = e.clientX - start.x, dy = e.clientY - start.y;
            if (!start.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            start.moved = true;
            this.el.classList.add('dragging');
            this.place({ right: start.right - dx, bottom: start.bottom - dy });
            e.preventDefault();
        };
        const up = e => {
            if (!start) return;
            const moved = start.moved;
            start = null;
            this.el.classList.remove('pressed', 'dragging');
            this.el.releasePointerCapture?.(e.pointerId);
            if (moved) this.setPos?.(this.current);
            else this.onClick?.();
        };
        this.el.addEventListener('pointerdown', down);
        this.el.addEventListener('pointermove', move);
        this.el.addEventListener('pointerup', up);
        this.el.addEventListener('pointercancel', () => { start = null; this.el.classList.remove('pressed', 'dragging'); });
        this.el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.onClick?.(); } });
        this.el.addEventListener('click', e => e.preventDefault()); // 点击由 pointerup 处理，免得拖完又触发一次
    }

    setBadge(n) {
        this.badge.hidden = !n;
        this.badge.textContent = n > 99 ? '99+' : String(n || '');
        this.el.title = n ? `报刊回声 · ${n} 条待审核` : '报刊回声';
    }
    setVisible(on) { this.el.hidden = !on; }
    setActive(on) { this.el.classList.toggle('active', !!on); }

    destroy() {
        window.removeEventListener('resize', this.onResize);
        this.el.remove();
    }
}
