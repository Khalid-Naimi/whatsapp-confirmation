# Instructions for sessions working in this repository

This is the WhatsApp confirmation service that runs on Render. A push to `main` auto-deploys it.

## Merging and building (standing rule)

The full rule is in `AGENTS.md` of the desktop repo (`connector-wo-hd`), section "Merging and building (standing rule)". Short version:

1. Merge your own finished work into `main` yourself, after the tests pass (`npm test`). Do not ask the user to merge or push.
2. Merge in a clean checkout (a throwaway `git worktree` of `origin/main`), never by resetting or cleaning another folder that holds other sessions' work.
3. Because `main` deploys, keep risky features (for example stock writes) off by default and say in your report that it deployed.
4. Check nothing is left unmerged before you report done (`git log origin/main..<your-branch>` is empty).
5. Never commit secrets, customer data, phone numbers, or `.env` files.
