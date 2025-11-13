```markdown
# cricketalok-bot

CricketPCG — Hand-Cricket Telegram Bot (1v1 PvP)

Features
- Solo lobby (quick 1v1 PvP)
- Ball-by-ball private-number bowling and group-number batting
- Uploadable animations for outcomes (1-6, W, bowling, batting)
- Live scoreboard, members list, and Man of the Match
- Admin tools: /addanim, /animlist, /backup, /restore
- Backup is gzipped SQLite; restore reloads DB in-process

Requirements
- Node.js >= 18
- Telegram bot token (BOT_TOKEN)
- An admin Telegram user ID set in ADMIN_IDS

Quick start
1. Clone or create a new repo and copy files.
2. Run: `npm install`
3. Create a `.env` file from `.env.example` and set values.
4. Start the bot: `npm start`

Environment (.env)
- BOT_TOKEN - your Telegram bot token
- ADMIN_IDS - comma-separated admin Telegram IDs (e.g. 12345678)
- DB_PATH - optional path to sqlite DB (default: ./data/games.db)
- MODE_CHOICE_IMAGE_URL - optional URL for the mode selection image
- BOT_OWNER, SUPPORT_URL - optional links used in /start

Deploy
- Run under a process manager (pm2, systemd) or use Docker. Make sure the bot runs 24/7 and admins can use /restore to reload DB.

Security & notes
- Admin-only commands are gated by ADMIN_IDS.
- Backups include the SQLite DB (games, animations, settings). Keep them safe.
- Users must start a private chat with the bot so it can send bowling prompts.

License
MIT
```