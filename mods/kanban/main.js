// かんばん: <プロジェクト>/.kanban/tasks/<フォルダ> を1枚のカードにして並べる。列・担当は <プロジェクト>/.kanban/config.json で決める。
// 開くときの props に {"project": "~/work/myapp"} を渡す。無ければ従来どおり mods/kanban/config.json（work_dir/tasks）を読む。
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, openOverlay, closeOverlay, exec, agents, theme, watchFolder, home, appHome, panes, focused, spaces, run, shared, setShared, readTextFile } from "herdr";


export default class Kanban extends View {
  init(_props, cx) {
    // props は init の引数には入らず props() から取る（2026-10-31 Herdr.app 0.1.10 の実測）
    const p = props() ?? _props;
    this.project = p?.project ? this.expand(String(p.project)).replace(/\/+$/, "") : null;
    this.cfg = null;
    this.cards = [];
    this.error = null;
    this.msg = null;
    this.busy = false;
    this.input = InputState.new({ placeholder: "タスクを1行で書いて Enter" });
    this.input.on("submit", (_e, cx) => this.addTask(cx));
    cx.timer.every(5000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      await this.refresh(cx);
      for (;;) {
        if (!this.dir) return;
        try { await watchFolder(this.dir); } catch (e) { return; }
        await this.load(cx);
      }
    });
  }

  expand(p) { return p.replace(/^~/, home()); }

  // 設定・roles.md・tasks の置き場。project があれば <project>/.kanban/、無ければ従来の場所。
  workDir() {
    const w = this.cfg?.work_dir;
    if (this.project) return w ? (w.startsWith("/") || w.startsWith("~") ? this.expand(w) : `${this.project}/${w}`) : this.project;
    return this.expand(w ?? "~");
  }

  async refresh(cx) {
    try {
      const path = this.project ? `${this.project}/.kanban/config.json` : `${appHome()}/mods/kanban/config.json`;
      const txt = await readTextFile(path);
      // ファイルが無いと readTextFile は null を返すだけなので、黙って空にせず理由を出す
      if (txt == null) throw new Error(`見つかりません: ${path}`);
      this.cfg = JSON.parse(txt);
      this.dir = this.project ? `${this.project}/.kanban/tasks` : `${this.workDir()}/tasks`;
      await exec("mkdir", ["-p", this.dir]);
      this.error = null;
    } catch (e) {
      this.error = `config.json: ${String(e?.message ?? e)}`;
    }
    await this.load(cx);
  }

  cols() {
    const c = this.cfg;
    return [c.first_column, ...c.stages.map((s) => s.name), c.done.name];
  }

  // state「<工程名> 作業中|完了 <担当>」から今いる工程の列を決める。move_on のファイルがあれば、その工程の列まで進める。
  parseState(text) {
    const m = (text ?? "").trim().match(/^(\S+)\s+(\S+)\s*(.*)$/);
    return m ? { stage: m[1], status: m[2], agent: m[3] } : null;
  }

  columnOf(files, st) {
    const c = this.cfg;
    const names = c.stages.map((s) => s.name);
    let col = 0;
    const i = st ? names.indexOf(st.stage) : -1;
    if (i >= 0) col = i === names.length - 1 && st.status === "完了" ? names.length + 1 : i + 1;
    for (const m of c.move_on ?? []) {
      const j = names.indexOf(m.to);
      if (j >= 0 && files.includes(m.file) && col < j + 1) col = j + 1;
    }
    return col;
  }

  async load(cx) {
    if (!this.cfg) { cx.notify(); return; }
    try {
      const r = await exec("sh", ["-c",
        'for d in */; do [ -d "$d" ] || continue; d=${d%/}; printf "%s\\t" "$d"; ls -1 "$d" | tr "\\n" " "; printf "\\t"; head -n 1 "$d/state" 2>/dev/null | tr -d "\\n"; printf "\\t"; head -n 1 "$d/task.md" 2>/dev/null | tr -d "\\n"; printf "\\n"; done'],
        { cwd: this.dir });
      const na = this.cfg.needs_action;
      this.cards = r.stdout.split("\n").filter(Boolean).map((line) => {
        // タスクが0件でも "*/" をカードにしない（[ -d ] で外す）。4つ目は task.md の1行目＝元の依頼
        const [name, rest = "", stateText = "", title = ""] = line.split("\t");
        const files = rest.split(" ").filter(Boolean);
        const state = this.parseState(stateText);
        return { name, title: title.trim(), state, col: this.columnOf(files, state), finished: this.cfg.stages.map((st) => files.includes(st.files[st.files.length - 1])), action: !!na && files.includes(na.when) && !files.includes(na.unless) };
      });
    } catch (e) {
      this.error = String(e?.message ?? e);
    }
    cx.notify();
  }

  // 入力欄の文を、次の番号のタスクフォルダの task.md にして、デザインの担当へ知らせる。
  addTask(cx) {
    const text = this.input.value().replace(/\s*\n\s*/g, " ").trim();
    if (!text || !this.cfg || this.adding) return;
    this.adding = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c",
          'cd "$1" || exit 1; n=1; for d in T[0-9]*; do [ -d "$d" ] || continue; k=${d#T}; case $k in *[!0-9]*) continue;; esac; if [ "$k" -ge "$n" ]; then n=$((k+1)); fi; done; mkdir "T$n" && printf "%s\\n" "$2" > "T$n/task.md" && echo "T$n"',
          "sh", this.dir, text]);
        const task = r.stdout.trim();
        if (r.code !== undefined && r.code !== 0 || !task) throw new Error(r.stderr || "作れませんでした");
        this.input.set_value("");
        const first = this.cfg.stages[0]?.name;
        // 宛先は「担当を起動」で控えた物。無ければ、このかんばんと同じ space のタブ名で探す（ほかの space の同名タブへ送らない）
        let to = this.addr?.[first];
        if (!to) {
          const sp = spaces().find((x) => x.id === (this.space ?? focused()?.space));
          to = sp?.tabs.find((x) => x.name === first)?.terminals?.[0]?.terminal;
        }
        if (to) {
          await exec("hc", ["send", to, `${task} を始めて`]);
          this.msg = `${task} を作り、${first}の担当へ送りました`;
        } else {
          this.msg = `${task} を作りました（${first}の担当がいないので送っていません。「担当を起動」を押してください）`;
        }
        await this.load(cx);
      } catch (e) {
        this.msg = `タスクを足せませんでした: ${String(e?.message ?? e)}`;
      }
      this.adding = false;
      cx.notify();
    });
  }

  // カードを選ぶと、詳細をポップアップ（ダイアログ）で出す。開いていれば閉じて開き直す。
  select(name) {
    setShared("kanban.selected", name);
    if (this.overlay) closeOverlay(this.overlay);
    this.overlay = openOverlay({ mod: "kanban-detail", kind: "dialog", props: { task: name, project: this.project }, width: 600, height: 760 });
  }

  // 「担当を起動」: 押したときだけ、工程の名前のタブで担当を起動し、roles.md の役割を送る。
  assemble(cx) {
    if (this.busy || !this.cfg) return;
    this.busy = true;
    this.msg = "担当を起動しています…";
    cx.notify();
    const home0 = focused();
    const kanbanTab = home0?.tab;
    const spaceId = home0?.space;
    cx.spawn(async (cx) => {
      try {
        const cfg = this.cfg;
        const rolesText = await readTextFile(`${this.project ? `${this.project}/.kanban` : this.workDir()}/roles.md`);
        if (rolesText == null) throw new Error("roles.md が読めません");
        const sec = {};
        for (const part of rolesText.split(/^## /m).slice(1)) {
          const nl = part.indexOf("\n");
          sec[part.slice(0, nl).trim()] = part.slice(nl + 1).trim();
        }
        const space = spaces().find((s) => s.id === spaceId);
        const existing = (name) => space?.tabs.find((t) => t.name === name);
        const addr = {};
        const started = [];
        // 次の担当の宛先を {next} に入れるため、後ろの工程から起動する。
        for (let i = cfg.stages.length - 1; i >= 0; i--) {
          const st = cfg.stages[i];
          const next = i + 1 < cfg.stages.length ? addr[cfg.stages[i + 1].name] ?? "" : "";
          const prompt = [`あなたの工程は「${st.name}」です。`, sec["共通"] ?? "", sec[st.name] ?? ""]
            .join("\n").replace(/\s*\n\s*/g, " ").replaceAll("{work_dir}", this.workDir()).replaceAll("{next}", next).replaceAll("{agent}", st.agent.name);
          const ex = existing(st.name);
          if (ex?.terminals?.[0]) {
            // もうあるタブは起動し直さず、役割だけ送る。
            addr[st.name] = ex.terminals[0].terminal;
            await exec("hc", ["send", addr[st.name], prompt]);
            continue;
          }
          const command = st.agent.command.map((a) => this.expand(a));
          const argv = [...command, ...(st.agent.prompt_flag ? [st.agent.prompt_flag] : []), prompt];
          const r = await exec("herdr-app", ["do", "tab.new", "--name", st.name, "--space", spaceId,
            "--folder", this.workDir(), "--argv", JSON.stringify(argv)]);
          const out = JSON.parse(r.stdout);
          if (out.error || !out.terminal) throw new Error(`${st.name}: ${out.error ?? r.stdout}`);
          addr[st.name] = out.terminal;
          started.push({ name: st.name, tab: out.tab });
        }
        // 工程の順にタブを並べ、かんばんを前に出したままにする。
        const now = spaces().find((s) => s.id === spaceId);
        let idx = (now?.tabs.findIndex((t) => t.id === kanbanTab) ?? 0) + 1;
        for (const st of cfg.stages) {
          const t = now?.tabs.find((x) => x.name === st.name) ?? started.find((x) => x.name === st.name);
          if (!t) continue;
          idx += 1;
          await exec("herdr-app", ["do", "tab.move", "--id", t.id ?? t.tab, "--index", String(idx)]);
        }
        this.addr = addr; // 入力欄のタスクを、このかんばんの space の担当へ送るために控える
        this.space = spaceId;
        await exec("herdr-app", ["do", "tab.select", "--id", kanbanTab]);
        this.msg = `担当を起動しました（起動 ${started.length}、既存 ${cfg.stages.length - started.length}）`;
      } catch (e) {
        this.msg = `担当を起動できませんでした: ${String(e?.message ?? e)}`;
        if (kanbanTab) await exec("herdr-app", ["do", "tab.select", "--id", kanbanTab]).catch(() => {});
      }
      this.busy = false;
      cx.notify();
    });
  }

  bar(done, total, color, t, h) {
    return h_flex().w_full().h(h).rounded(h / 2).bg(t.border).overflow_hidden()
      .child(div().h_full().bg(color).flex_grow(done))
      .child(div().h_full().flex_grow(Math.max(total - done, 0)));
  }

  // 全体の進み具合: タスク数×工程数のうち、終わった工程（その工程の最後のファイルがある）の割合。
  progress(t) {
    const stages = this.cfg.stages;
    const n = this.cards.length;
    const per = stages.map((_, i) => this.cards.filter((c) => c.finished[i]).length);
    const done = per.reduce((a, b) => a + b, 0);
    const total = n * stages.length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    return v_flex().gap(6).p(10).rounded(8).bg(t.chrome)
      .child(h_flex().items_baseline().gap(8)
        .child(div().text_size(22).font_semibold().text_color(t.foreground).child(`${pct}%`))
        .child(div().text_size(12).text_color(t.muted).child(`全体の進み具合: ${done} / ${total} 工程（${n} タスク × ${stages.length} 工程）`)))
      .child(this.bar(done, total, t.accent, t, 10))
      .child(h_flex().gap(12).children(stages.map((s, i) => v_flex().flex_1().gap(3)
        .child(div().text_size(10.5).text_color(t.dim).child(`${s.name} ${per[i]}/${n}`))
        .child(this.bar(per[i], n, t.accent, t, 5)))));
  }

  card(c, t, cols) {
    const ag = c.state; // まだ state が無い(誰も手を付けていない)カードには出さない
    const red = c.action; // 承認待ち: デザインレビューの列のまま、カード全体を赤くする
    const color = red ? t.background : ag ? (ag.status === "作業中" ? t.working : t.muted) : t.dim;
    const sel = shared("kanban.selected") === c.name;
    const cp = this.compact;
    return v_flex().id(`card-${c.name}`).gap(cp ? 4 : 8).p(cp ? 6 : 10).rounded(8)
      .bg(red ? t.blocked : t.raised).border(sel || red ? 2 : 1)
      .border_color(sel ? t.accent : red ? t.blocked : t.border)
      .hover((s) => s.opacity(0.92)).on_click(() => this.select(c.name))
      .child(div().text_size(cp ? 13 : 15).font_semibold().text_color(red ? t.background : t.foreground).child(c.name))
      .when(!!c.title, (el) => el.child(div().text_size(cp ? 11 : 12).whitespace_normal().text_color(red ? t.background : t.muted)
        .child(c.title.length > 40 ? `${c.title.slice(0, 40)}…` : c.title)))
      .when(red, (el) => el.child(
        div().px(6).py(2).rounded(4).bg(t.background).text_color(t.blocked).text_size(11).font_semibold().child(cp ? "要対応" : "要対応（承認待ち）")))
      .when(ag, (el) => el.child(
        h_flex().gap(cp ? 4 : 6).items_start().pt(cp ? 4 : 6).border_t(1).border_color(red ? t.background : t.border)
          .child(div().mt(4).w(8).h(8).rounded(4).bg(color))
          .child(v_flex().flex_1().min_w(0).gap(1)
            .child(div().text_size(cp ? 11 : 12).font_semibold().text_color(color).child(ag.status))
            .when(!cp, (el) => el.child(div().text_size(11).text_color(red ? t.background : t.muted).child(ag.agent))))));
  }

  render(cx) {
    const t = theme();
    const head = h_flex().gap(10).items_center()
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child("かんばん"))
      .child(div().id("assemble").px(10).py(4).rounded(6).text_size(12).font_semibold()
        .bg(this.busy ? t.dim : t.solid).text_color(t.solid_foreground)
        .on_click((_e, cx) => this.assemble(cx)).child("担当を起動"))
      .when(this.msg, (el) => el.child(div().text_size(11).text_color(t.muted).child(this.msg)));
    const field = Input.new(this.input).h(32).px(10).rounded(8).border_1().border_color(t.input)
      .bg(t.background).text_size(13).text_color(t.foreground);
    const root = v_flex().id("kanban-root").on_size_change((sz, cx) => { const c = sz.width < 760; if (c !== this.compact) { this.compact = c; cx.notify(); } }).size_full().bg(t.surface).p(12).gap(10).child(head)
      .when(this.cfg, (el) => el.child(this.progress(t)))
      .child(field)
      .when(this.error, (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)));
    if (!this.cfg) return root;
    const cols = this.cols();
    const cp0 = this.compact;
    const agentName = (i) => this.cfg.stages[i - 1]?.agent?.name;
    // 列は横一列。各列は最低124px、狭いときは横にスクロールする（字を縦に割らない）。
    return root.child(h_flex().id("board").flex_1().gap(cp0 ? 5 : 8).items_stretch().overflow_x_scrollbar()
      .children(cols.map((name, i) => {
        const cs = this.cards.filter((c) => c.col === i);
        const who = agentName(i);
        const cp = this.compact;
        return v_flex().id(`col-${i}`).w(0).flex_grow(1).min_w(cp ? 62 : 124).gap(8).p(cp ? 5 : 8).rounded(8).bg(t.chrome).overflow_hidden()
          .child(v_flex().gap(2).pb(6).border_b(1).border_color(t.border)
            .child(h_flex().gap(4).items_start()
              .child(div().flex_1().min_w(0).text_size(cp ? 11 : 13).font_semibold().text_color(t.foreground).child(name))
              .child(div().px(cp ? 4 : 6).rounded(8).bg(t.border).text_size(cp ? 10 : 11).text_color(t.muted).child(String(cs.length))))
            .when(!cp, (el) => el.child(div().min_w(0).h(28).text_size(10.5).text_color(t.dim).child(who ?? ""))))
          .child(v_flex().id(`list-${i}`).gap(cp ? 6 : 8).flex_1().overflow_y_scrollbar()
            .children(cs.map((c) => this.card(c, t, cols))));
      })));
  }
}
