---
name: ashare-news
description: Fetches the latest A-share telegraph news items and market indices from Cailian Press and saves them to a Markdown file. Use this skill when the user asks to get, update, or fetch A-share news.
---

# A-Share News Fetcher

This skill helps you fetch the latest telegraph news items and market indices from Cailian Press (财联社) and prepends them to a Markdown file.

## Workflow

When triggered, follow these steps:

1. **Run the Fetch Script:** Execute the bundled Node.js script using the `run_shell_command` tool.
   ```bash
   node scripts/fetch_news.cjs
   ```
   *Note: The script automatically handles prepending the news and adding the execution timestamp to `/home/zhihaotan/work_logs/ashare_news.md`.*

2. **Report Success:** Print out the fetched news items and market indices in your chat response so the user can read them directly. Also notify the user that the news has been successfully prepended to `/home/zhihaotan/work_logs/ashare_news.md`.
