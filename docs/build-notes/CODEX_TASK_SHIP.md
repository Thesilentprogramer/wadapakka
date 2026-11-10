# Task: fix Eval, Ledger and Handoff desk, then put WadaPakka on GitHub and live. HARD time box: finish in 35 minutes. The submission deadline is 11:59 PM IST tonight.

## Absolute rules
- NEVER print, log, echo or commit the contents of .env or the GNANI_API_KEY value. Before every commit, run `git ls-files | grep -E '^\.env'` and confirm the output is empty.
- Make small, meaningful commits with clear messages (author is the existing git config; if it is unset, use `-c user.name="Shubham Indulkar"` and leave the email blank, or use GitHub's noreply address from `gh api user`).
- Don't touch port 8000 until the end. Test on port 8001.

## 1. Fix Eval, Ledger and Handoff desk in the React app (web/), about 15 minutes
The owner reports that the Eval, Ledger and Handoff desk sections "are not working". Find out why: check whether the nav or FolderFloat actually renders those sections, whether they call `/api/eval` and `/api/ledger`, and whether a handoff UI exists at all. The backend in app.py has `GET /api/eval`, `GET /api/ledger` and handoff logic (detect_handoff, handoff_brief).
- **Eval**: a "Run eval" button calls /api/eval and shows a results table (case, naive vs layer, pass/fail), plus loading and error states.
- **Ledger**: fetch /api/ledger on open and after every turn or commit, show the rows, and include a refresh button.
- **Handoff desk**: list the handoffs that happened during sessions, each with its reason and brief. If the backend doesn't expose a list, add a small `GET /api/handoffs` endpoint that records them in memory. Also add a "Trigger sample handoff" line, for example "mujhe aapke manager se baat karni hai", so the desk can be demoed.
- Make every nav link, tab and FolderFloat item scroll to and activate the right section.
- Verify with curl against a test server on port 8001. Run `cd web && PATH=/opt/homebrew/bin:$PATH npm run build` and `.venv/bin/pytest -q`, and add a test for any new endpoint. Commit.

## 2. New GitHub repo, about 5 minutes
- `gh` is logged in as Thesilentprogramer. Create a NEW PUBLIC repo named `wadapakka` (if that name is taken, use `wadapakka-voice-reliability`). Description: "Reliability layer between Gnani Prisma STT and Timbre TTS for Hinglish promise-to-pay voice calls."
- Tidy the repo before pushing. Move the CODEX_TASK_*.md files into docs/build-notes/, make sure .gitignore covers .env, *.log, __pycache__, web/node_modules and .venv, and add `.env.example` with `GNANI_API_KEY=`.
- Rewrite README.md: what it is, the problem, the architecture (with a mermaid diagram), the measured results (only numbers from docs/eval_results.md and docs/api_notes.md), how to run it locally, the live URL, and a screenshot from docs/shots/.
- Push with `git push -u origin main` (rename the branch to main if needed). Add topics: gnani, voice-ai, stt, tts, hinglish, fastapi, react.

## 3. Go live, about 15 minutes
The app is FastAPI (app.py) serving the built web/dist, with WebSockets for L2 streaming and ffmpeg for L1 WebM.
- Add a Dockerfile: python:3.11-slim plus apt ffmpeg, plus node to build web/ (multi-stage build). Run `uvicorn app:app --host 0.0.0.0 --port $PORT`.
- Add a render.yaml for a free web service with env var GNANI_API_KEY set to sync:false.
- Try deploying to Render with the installed `render` CLI if it's logged in (`render whoami`), or with the Render API if a key is available in the environment. Set GNANI_API_KEY from .env without printing it.
- If you can't create the Render service non-interactively, do NOT stall. Push render.yaml anyway and write the one-click link `https://render.com/deploy?repo=<repo url>` into the final summary.
- As an instant fallback, check for `cloudflared` (`brew install cloudflared` if it's quick). Start the app on port 8000 with the new build, then run `nohup cloudflared tunnel --url http://localhost:8000 > tunnel.log 2>&1 &` and report the trycloudflare.com URL from tunnel.log. Make sure the URL loads (curl returns 200).
- Put the live URL in the README and push.

## Final summary (short)
Include the repo URL, the live URL(s), what you fixed in each of the three sections, the test and build results, and anything left for the owner to do (e.g. clicking the Render deploy link and pasting the key).
