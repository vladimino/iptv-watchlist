---
name: github-mermaid-qa
description: How a session verifies that Mermaid diagrams of an IPTV Watchlist PR render on GitHub itself (headless Chromium against the pushed blob page, no screenshots, no login), and what to record in the PR. Use for every PR that changes a Mermaid block, before saying the visual gate is done or "could not be checked".
---

# GitHub-rendered Mermaid QA

The project gate ([agent workflow](../../../docs/process/agent-workflow.md), Visual QA; AGENTS.md) asks for the diagrams **as GitHub renders them**, not only a syntax check and not a local mermaid render (a local render uses another mermaid version and does not prove GitHub's output). A session can do this itself: Chromium and Playwright are pre-installed, and the repository pages are readable without a login. Do not report "GitHub rendering could not be inspected from this environment": run the check.

## How

1. Push the branch first. GitHub renders the file at the pushed commit, so use the **exact HEAD**: `https://github.com/<owner>/<repo>/blob/<head sha>/<path>.md` (a branch name works too, the SHA pins the reviewed commit). The PR "Files changed" tab does not render Mermaid; the blob page does.
2. Run, once per changed page, with one needle per new label that must appear in a diagram:

```bash
node .claude/skills/github-mermaid-qa/check.cjs "https://github.com/<owner>/<repo>/blob/<head sha>/docs/architecture/<page>.md" "<text from the new diagram>" "<another label>"
```

   `require('playwright')` works from any directory; do not run `playwright install`. The script waits for GitHub's `viewscreen.githubusercontent.com` iframes, reads each diagram's SVG, and prints one JSON line per diagram (`ok`, size, label count, `textOutsideSvg`, `error`), one line per needle (which diagram holds it) and a final `PASS`/`FAIL` verdict with the exit code.
3. `PASS` means: every diagram on the page rendered an SVG, none shows a Mermaid error, no label sits outside its SVG, and each needle is in a rendered diagram. A diagram you did not change also failing is a real finding (report it, it may be older).

## What it does not do

- It saves no file. Do not create, save, download, attach or commit screenshots (AGENTS.md, Visual QA). If a human-readable check of hierarchy and arrow meaning is also wanted, read the Mermaid source and the SVG labels and say so in words; do not attach an image.
- It checks rendering and legibility signals, not whether the arrows tell the truth. Arrow semantics (who calls whom, what happens before what) are checked by reading the source against the code, as before.
- It is the executor's evidence. The independent reviewer may repeat it on the exact HEAD; record the command, the HEAD SHA and the verdict so they can.

## What to write in the PR

A short written report in the Tests section, for example: `GitHub-rendered Mermaid QA on <sha>: epg-and-availability.md 2 diagrams PASS, scheduling-and-orchestration.md 13 diagrams PASS (no error, no text outside the SVG, needles found); checked with .claude/skills/github-mermaid-qa/check.cjs`. Repeat it after any later push that touches a Mermaid block.
