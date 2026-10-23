# dsh-maoying (Maoying)

[中文](README.md) | English

**Maoying** literally means "the brush" — in *Maoying Zhuan* (毛颖传, "The Biography of the Brush"), Han Yu wrote a writing brush as a courtier with a fief and a title. dsh-maoying fits that brush into DSH (DeepSeek Harness): **a brush that manages a crew of helpers and guards a stack of manuscripts** — a web-novel writing assistant plugin, fully original, released under MIT.

Once installed, the main agent becomes the **editor-in-chief of your novel**: it runs a seven-phase workflow with a six-step writing method, delegating outlining, drafting, review, lore-keeping and research to five helpers who each carry only their own tools. The whole novel is a structured markdown/YAML `novel/` directory in the workspace (character cards, foreshadowing state machine, timeline, clue board, narrative memory) — agents read and write files directly, **no database, no API layer**. "Show all unresolved foreshadowing" is one line of grep.

## Features

- **Editor-in-chief + five helpers**: the main agent plans, connects, reviews and advances states; the outliner (outline), writer (write), reviewer (review), lore keeper (lore) and researcher (research) each carry their own tools. Trivial errands like finding a file or checking a foreshadow status, the chief handles itself with glob/grep.
- **novel/ as a file database**: character cards, worldbuilding & science settings with three-color tags, relations graph, foreshadow ledger, timeline, narrative memory, clue board — all grep-friendly flat-key/top-level-array YAML, human-editable, git-versioned, no migrations, no ops.
- **Seven-phase workflow**: idea → setting → outline → writing → review → consistency → export. The phase lives in the `phase` key of project.yml; the chief advances it at each milestone and reports to you, with completion gates (core settings saved; volume plan and the target chapter outline in place before writing) — unmet, it steps back a phase.
- **Writing six-step method**: continuity check → outline → draft → review → revision → finalization, looping per chapter; paired with the Collab four-step co-writing flow (setting co-creation → volume planning → golden three chapters → handoff loop) it takes a new book from zero to rolling updates; the setting digest and the volume plan each get a user sign-off, and the golden three chapters wait until settings are locked.
- **Foreshadowing state machine**: planted → progressing → resolved / abandoned, with planting and payoff chapter numbers, expected-payoff scheduling and priority tiers — a long serial never drops a thread; past 15 active foreshadowing entries the chief proactively suggests cleanup.
- **Context on demand**: the chief reads index.yml for the big picture, then pulls only what the chapter at hand needs (previous chapter's ending ≈1500 chars + its outline + on-stage character cards + active foreshadow excerpts) — never the whole book.
- **Narrow tool surface**: the chief sees only "role delegation + internal retrieval + coordination"; helpers carry their line's tools (reviewer read-only, researcher web+notes only) — less per-request tool overhead and context weight.
- **Research**: the research helper searches the web for historical/geographic/domain material, files notes under `novel/research/`, separating fact from common lore from legend, with sources — a dividend of the DSH architecture.
- **Creator panel**: a full-page web panel from the DSH sidebar — Overview (with in-place manuscript metadata editing and volume plan) / Chapters / Characters / Foreshadowing / Relations / Timeline / Worldbuilding / Style / Index Board, nine tabs; full-page chapter reading (outline side-by-side + manuscript/outline editing with save + five-dimension fields + status flow), form-based project.yml editing, style baseline viewing & editing (created from the default baseline when missing), UI language (中文/English), six font-size steps, and automatic new-version detection.
- **CLI fallback**: `maoying init / stats / index / export / brief / check` — six zero-dependency commands for scaffolding, stats, index rebuild, export, per-chapter writing cards and static checks.

## Quick Start

Prerequisites: **Node.js ≥ 18** and an installed DSH host (**0.1.7+**, see "Compatibility").

The official plugin channel — one command, then restart:

```bash
dsh plugin --profile web add dsh-maoying
```

**Restart DSH (`dsh web`)**: at startup the plugin installs the preset into `~/.dsh/.agent-presets/maoying/` and writes the managed declaration block into `~/.dsh/cordis.patch.yml` — no buttons to press. Pick "**毛颖创作 (Maoying)**" in the preset selector of a new session; to make it default, select it in Settings → Agent Presets.

For a development checkout (you want to modify the plugin or preset sources), link the repo directly; changes take effect after a restart:

```bash
git clone https://github.com/lifangjin/dsh-maoying.git
dsh plugin --profile web add link:"$PWD/dsh-maoying"
```

Only want the command-line tool, without the plugin? The zero-dependency CLI works standalone via `npx`, or as a global command (both npm channels, independent of the plugin):

```bash
npx maoying init                 # run without installing
npm install -g dsh-maoying       # or install a global maoying command
```

## How to Use

With the preset selected, just talk to the chief; it routes by the workflow itself:

**Start a new book (Collab four-step co-writing)**:

> I want to write an Eastern fantasy where the protagonist's golden finger is hearing objects speak and appraising treasures to level up.

The chief aligns the setting with you item by item (genre, golden finger, tone, the protagonist's want/obstacle/leverage, the core opposition); the lore keeper saves core character cards and worldbuilding entries for your sign-off, the outliner's volume plan gets a second sign-off — only then are the golden three chapters (world hook, protagonist motivation, core conflict) written and delivered.

**Per-chapter writing (Writing six-step method)**:

> Can we start chapter 3?

The chief runs the continuity check, has the outliner produce the chapter outline (with the five narrative dimensions), and after your sign-off sends it to the writer, then the reviewer (checklist + four-dimension consistency scan); issues go back to the writer; once accepted, the lore keeper does finalization upkeep — you only call the shots at decision points.

**Consistency pass**:

> Run a consistency check over the first 20 chapters.

The chief advances the phase to consistency; the reviewer scans four dimensions — conflicts / timeline / foreshadowing / settings — and returns issues ranked by severity.

A reply of "ok / sure / go on" counts as confirmation; the chief advances directly without echoing it back.

## Creator Panel

Open "**毛颖创作台**" at the bottom of the DSH sidebar — a full-page cockpit for the human eye, beyond what agents do:

- **Chapters**: status filters + the writing queue; click a chapter for full-page reading — back button, outline side-by-side (Markdown rendered), in-place editing with save for the manuscript and the outline (textarea with manual save; if the file was changed externally while editing, saving is rejected and the latest content restored, never overwriting manual edits), five narrative-dimension fields, one-click status flow.
- **Overview**: the "Edit" button on the manuscript card expands form-based editing of project.yml — title / author / genre / planned length / language / workflow phase / co-writing mode / synopsis (the former "Novel Settings" tab, merged in); saving preserves the file's existing comments. If project.yml was changed externally after the form loaded (manual edits or an agent advancing the phase), saving is rejected with a prompt to re-edit from the latest content instead of overwriting. A separate "Volume plan" card lists each volume's positioning and planned chapter range from volumes.yml — signed-off volume plans are visible in the panel.
- **Top bar**: current version always visible; a "new version ↗" badge links to the release page when npm has a newer one, next to an "Upgrade now" button that installs the latest release into the current DSH profile with pnpm (profile-directory installs only, with an automatic corepack fallback when pnpm is missing; when a global `maoying` CLI is detected it is updated to the same exact version, and skipped if absent; a DeepSeek restart is required to take effect); the gear opens Settings — UI language (中文/English), six font-size steps (100%–150%), all applied immediately and remembered.

The panel writes state (chapter status, project.yml, index.yml rebuilds) and offers prose/outline editing to humans only (hash-based stale-write detection — external changes are never overwritten); the agent boundary is unchanged: in co-writing, prose belongs to the author and the chief.

## Co-writing Mode (Author Writes)

Not everyone wants AI ghostwriting. The `mode` key in project.yml decides who writes the prose — three modes in one line each: `ai-draft` (default) AI drafts via the Writing six-step method; `co-write` assigns a writer per chapter, and the chief asks who writes before touching the pen; `author-draft` the author writes the whole book, and Maoying only preps, reviews and keeps the books — never ghostwrites.

The author-draft loop — you just write, hand it over, and the chores are taken care of:

> Chapter 5 is done, here it is. (paste the text, or just say chapter X is done and point at a file)

After receiving a manuscript you get three things: a **review checklist** (issues only, no rewriting — applying them is up to you), a **ledger backfill** (foreshadowing / timeline / relations / memory / clue board recorded from what your text actually does, even off-plan changes, tagged `backfill`), and the **next chapter outline** (`novel/outlines/vXX-cXXX.md`, ready to write from).

Companion commands: `maoying brief <dir> <chapter>` packs a per-chapter writing card (outline + previous ending + character cards + active foreshadowing — carry it to any editor or AI), and `maoying check <dir>` runs a zero-model static check (frontmatter completeness, foreshadow chapter references, timeline ordering, phase readiness gates — no model calls; LLM review goes through the chief).

## Methodology Skills

The plugin ships 4 web-novel methodology skills. At startup the installer drops four `maoying-*` directories under `~/.dsh/skills/` (i.e. `<home>/skills/`) where the host's skill panel lists them; the outliner, writer, reviewer and lore keeper load them by scenario — no manual steps:

| Skill | One-liner |
|---|---|
| maoying-golden-opening | Golden three chapters: role split of the first three chapters (world hook → motivation → conflict detonation), the "something happens in the first 300 words" rule, information-release discipline and a self-check list |
| maoying-beat-pacing | Payoff pacing: a payoff-type library, suppression-release ratios, chapter/arc/book pacing curves and chapter-end hook selection |
| maoying-review-checklist | Review checklist: seven layers (language / pacing / characterization / logic / foreshadowing / spoilers / style) with P0/P1/P2 severity |
| maoying-foreshadow-discipline | Foreshadow management: register on planting, pacing & scheduling, the "surprising yet reasonable" payoff bar, and ledger cleanup thresholds |

The installer only touches `maoying-*` prefixed directories; your own skills under `~/.dsh/skills/` are untouched, byte for byte. After uninstalling the plugin, remove the skill directories manually (all four together):

```bash
dsh plugin --profile web remove dsh-maoying
rm -rf "${DSH_HOME:-$HOME/.dsh}/skills/"maoying-*
```

## The novel/ Data Spec

The `novel/` directory is the plugin's entire database: project.yml (metadata + seven-phase state), style.md (the writing style baseline), volumes.yml, chapters/ (frontmatter five narrative dimensions + prose), characters/ (character cards), world/, science/ (three-color settings), relations.yml, foreshadows.yml (the state machine), timeline.yml, memories.yml (with appearance records and the promise ledger), clue-board.yml, research/, exports/. Full formats, examples and design rationale:

- Quick reference: `novel/README.md` after project init (template source: [templates/novel/README.md](templates/novel/README.md))
- Full spec: [docs/spec.md](docs/spec.md) (why not SQLite, five-dimension field definitions, foreshadow state-machine semantics, appearance-record conventions)

## CLI

```bash
maoying init [dir]     # scaffold novel/ (default ./novel; existing files are always skipped, never overwritten)
maoying stats [dir]    # per-chapter CJK counts, status breakdown, current phase
maoying index [dir]    # rebuild index.yml from volumes.yml + chapters/ (derived file)
maoying export [dir]   # export the book: --format md|txt|epub (default md), --out <dir> to change destination
maoying brief [dir] <chapter>  # pack a per-chapter writing card (outline + previous ending + character cards + active foreshadowing); --out to write to disk, stdout by default
maoying check [dir]    # static check (no model calls): frontmatter / enums / chapter numbers / foreshadow refs / timeline years / relation-card refs / phase readiness gates
```

Export examples:

```bash
maoying export novel                      # Markdown, into novel/exports/
maoying export novel --format txt         # plain text
maoying export novel --format epub        # EPUB 3 (zero-dependency packaging, importable into readers)
maoying export novel --format epub --out ~/Downloads   # different destination
```

The output directory defaults to `<dir>/exports/`, file name `<title>-<YYYYMMDD>.<ext>` (title from project.yml); chapter parsing shares the same logic as stats/index, so frontmatter never leaks into prose.

Zero dependencies (node:fs/path/url/crypto), runs from any cwd. Install one of three ways: `npm install -g dsh-maoying`, on-demand `npx maoying <command>`, or `npm link` on a dev machine (repo checkout, edits take effect immediately). With none of these, `node <plugin dir>/bin/maoying.mjs` is equivalent (a dsh plugin install also drops the package into the profile, so you can point there directly). In day-to-day writing the lore keeper rebuilds index.yml directly; the CLI is mainly for humans.

## Uninstall

```bash
dsh plugin --profile web remove dsh-maoying
rm -rf "${DSH_HOME:-$HOME/.dsh}/.agent-presets/maoying"
rm -rf "${DSH_HOME:-$HOME/.dsh}/skills/"maoying-*
```

On DSH 0.1.7+ also delete the dsh-maoying managed block in `~/.dsh/cordis.patch.yml` (the whole section between `# --- dsh-maoying preset managed (auto-generated; do not edit) ---` and `# --- end dsh-maoying preset managed ---`, markers included), so no declaration lines point at a deleted directory. The `novel/` directory is your manuscript — uninstalling never touches it.

## Compatibility

At startup the plugin reads the host version (`<home>/node_modules/@deepseek-ai/dsh/package.json`) and picks the delegation-line shape automatically — **after a host upgrade, a restart is all it takes; no reinstall**:

- **DSH 0.1.7 – 0.2.1-rc.1 → v1 inline shape**: the 5 role delegation lines inline persona and toolFilter; the managed block is 1 declaration line.
- **DSH 0.2.1-rc.2+ → v2 AgentPreset shape**: from that version dsh-tool-subagent rejects inline persona/toolFilter, so the plugin switches to [presets/maoying/agent.cordis.v2.yml](presets/maoying/agent.cordis.v2.yml) — the managed block writes 6 declaration lines (chief-in-chief preset + 5 role presets: outliner / writer / reviewer / lore keeper / researcher); the chief's delegation line points at the role presets via `agentPreset`, and each role's tool surface is carried by the preset's entity tool lines (reviewer read-only, researcher with web search).
- **Role presets appear in the preset selector** (the host has no hiding mechanism for presets); their names carry "（内部）" to mark them: in daily writing they are picked automatically via chief delegation, but you can also select a writer/researcher directly for a session without the chief.
- Both shapes share persona text byte-for-byte from one source ([test/composition.test.mjs](test/composition.test.mjs) guards it); if the host version can't be read, the plugin falls back to v1 conservatively.
- The ≤0.1.6 directory-scan track: not supported (the host dropped it).

## License

[MIT](LICENSE) © 2026 lifangjin

## Acknowledgments

- "Maoying" comes from Han Yu's *Maoying Zhuan* (毛颖传): a writing brush personified, with a fief and a title.
