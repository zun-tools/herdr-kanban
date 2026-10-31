// かんばんで選んだタスクの詳細: 工程ごとのファイルの中身と、担当・その状態（表示のみ）。
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, shared, readTextFile, watchFolder, home, appHome } from "herdr";

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const STATUS_LABEL = { blocked: "待機中(要入力)", done: "完了通知", working: "作業中", idle: "待機" };

export default class KanbanDetail extends View {
  init(_props, cx) {
    this.task = null;
    this.texts = {};
    this.stages = [];
    cx.timer.every(3000, (cx) => this.load(cx));
    cx.spawn(async (cx) => {
      await this.load(cx);
      for (;;) {
        if (!this.dir) return;
        try { await watchFolder(this.dir); } catch (e) { return; }
        await this.load(cx);
      }
    });
  }

  async load(cx) {
    try {
      const project = props()?.project ? String(props().project).replace(/^~/, home()).replace(/\/+$/, "") : null;
      const cfg = JSON.parse(await readTextFile(project ? `${project}/.kanban/config.json` : `${appHome()}/mods/kanban/config.json`));
      this.stages = cfg.stages;
      this.dir = project ? `${project}/.kanban/tasks` : `${(cfg.work_dir ?? "~").replace(/^~/, home())}/tasks`;
    } catch (e) { return; }
    const task = props()?.task ?? shared("kanban.selected");
    if (!task) return;
    const texts = {};
    for (const s of this.stages) {
      for (const f of s.files) {
        texts[f] = await readTextFile(`${this.dir}/${task}/${f}`).catch(() => null);
      }
    }
    texts.state = await readTextFile(`${this.dir}/${task}/state`).catch(() => null);
    texts["task.md"] = await readTextFile(`${this.dir}/${task}/task.md`).catch(() => null);
    this.texts = texts;
    this.task = task;
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const sel = props()?.task ?? shared("kanban.selected");
    if (sel !== this.task) { this.task = sel; this.texts = {}; this.load(cx); }
    const body = v_flex().id("detail-scroll").size_full().min_h(0).bg(t.surface).p(14).pb(40).gap(12).overflow_y_scrollbar();
    if (!sel) return body.child(div().text_color(t.muted).child("かんばんでカードを選んでください"));
    const ov = props()?.overlay;
    body.child(h_flex().items_center()
      .child(div().flex_1().text_size(16).font_semibold().text_color(t.foreground).child(sel))
      .when(ov, (el) => el.child(div().id("close-detail").px(10).py(4).rounded(6).text_size(12).bg(t.raised)
        .text_color(t.foreground).hover((x) => x.bg(t.hover)).on_click(() => closeOverlay(ov)).child("閉じる (Esc)"))));
    // 元の依頼（task.md）を工程より先に出す
    const ask = this.texts["task.md"];
    if (ask != null) body.child(v_flex().gap(4).p(10).rounded(8).bg(t.chrome)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("依頼"))
      .child(div().text_size(12).whitespace_normal().text_color(t.foreground).child(ask.trim() || "（空）")));
    for (const s of this.stages) {
      // 担当の状態は state（「<工程名> 作業中|完了 <担当>」）から。この工程の行だけ出す。
      const m = (this.texts.state ?? "").trim().match(/^(\S+)\s+(\S+)\s*(.*)$/);
      const ag = m && m[1] === s.name ? { status: m[2], agent: m[3] } : null;
      const color = ag ? (ag.status === "作業中" ? t.working : t.muted) : t.dim;
      const files = s.files;
      body.child(v_flex().gap(6).p(10).rounded(8).bg(t.chrome)
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(13).font_semibold().text_color(t.foreground).child(s.name))
          .child(div().w(8).h(8).rounded(4).bg(color))
          .child(div().text_size(11).text_color(color)
            .child(ag ? `担当: ${ag.status} ${ag.agent}` : `担当: ${s.agent?.name ?? ""}`)))
        .children(files.map((f) => {
          const txt = this.texts[f];
          return v_flex().gap(2)
            .child(div().text_size(11).text_color(t.dim).child(f))
            .child(div().text_size(12).whitespace_normal()
              .text_color(txt == null ? t.dim : t.foreground)
              .child(txt == null ? "まだありません" : txt.trim() || "（空）"));
        })));
    }
    return body;
  }
}
