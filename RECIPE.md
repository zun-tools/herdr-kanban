# RECIPE: kanban mod for Herdr app (rebuild from an empty folder)

This file is enough to rebuild the mod. See README.md (Japanese) for usage; this file does not contradict it.

## Goal
A board that shows `<project>/.kanban/tasks/*` as cards in columns (one per stage), with an agent per stage, a progress summary, a task input, a button that starts the agents, and a detail dialog.

## Files
- `mods/kanban/mod.json`: `{ "place": "none", "title": "かんばん" }`; `main.js` default-exports a `View` subclass.
- `mods/kanban-detail/mod.json`: `{ "place": "none", "title": "タスク詳細" }`; opened as a dialog overlay by the board.
- Project side: `.kanban/config.json`, `.kanban/roles.md`, `.kanban/tasks/T<n>/`.

## Behavior
1. Project: opened with props `{"project": "<path>"}`. Config is `<project>/.kanban/config.json`; tasks are `<project>/.kanban/tasks`. Without `project`, read `<appHome>/mods/kanban/config.json` and `<work_dir>/tasks` (legacy).
2. Columns: `[first_column, ...stages[].name, done.name]`. A task folder is a card.
3. Column of a card: read the first line of `state`, `<stage> <作業中|完了> <agent>`. No state means column 0. Stage i in progress or done puts the card in column i+1; the last stage done puts it in the done column. A `move_on` entry `{file, to}` moves the card at least to that stage's column when the file exists.
4. Needs action: when `needs_action.when` exists and `needs_action.unless` does not, draw the whole card red with "要対応（承認待ち）".
5. Progress: finished stages / (tasks x stages), where a stage is finished when the last of its `files` exists. Bar per stage as well.
6. Refresh: `watchFolder(tasksDir)` loop plus a 5 s timer, running `ls` and `head -n 1 state` through `exec("sh", ["-c", ...], {cwd})`.
7. Add task: next free `T<n>`, write `task.md`, then `hc send <first stage agent address> "<T> を始めて"`. The agent is found with `agents()` by `tab_name == first stage name`.
8. Start agents (button "担当を起動"): read `roles.md`, split by `^## `. For stages from last to first (so `{next}` is known): build the prompt ("あなたの工程は「<stage>」です。" + 共通 + the stage section, with `{work_dir}`, `{next}`, `{agent}` replaced). If a tab with the stage name exists, `hc send` the prompt to it. Otherwise `herdr-app do tab.new --name <stage> --space <id> --folder <work_dir> --argv <json>` where argv is command + (prompt_flag) + prompt. Then order the tabs with `tab.move` and select the board tab. Message: "担当を起動しました".
9. Card click: `setShared("kanban.selected", name)` and `openOverlay({mod: "kanban-detail", kind: "dialog", props: {task, project}, width: 600, height: 760})`.
10. Detail: for every stage show its `files` (text or "まだありません") and the agent line from `state`; root container scrolls vertically (`overflow_y_scrollbar`, `min_h(0)`).

## API used (all already used in the shipped main.js)
`gpui-kit`: View, div. `gpui-base`: v_flex, h_flex, InputState, Input. `herdr`: openOverlay, closeOverlay, exec, agents, theme, watchFolder, home, appHome, panes, focused, spaces, run, shared, setShared, readTextFile (detail also: props).

## Approval protocol
Stage "デザインレビュー" writes `design_review.md` and tells no one. A human sends "<T> 進めて" to the implementation agent, which first writes `approved`. That file triggers `move_on` and clears the red state.
