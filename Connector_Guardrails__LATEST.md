/Your Friend Logan/ChatGPT_Assets/00_Admin/Start_Here/Policies/Connector_Guardrails__LATEST.md
# Connector Guardrails — No Contacts / No Gmail (Quill 3.7)
# Date: 2025‑10‑29 (PST)

Scope
- This policy applies to all assistants/agents operating on the YFL project (Quill 3.7+).
- Connectors that MAY be present in the UI: Google Drive, Google Contacts, Gmail, Calendar, GitHub, Notion, Linear.

Hard rules
1) Google Contacts — **PROHIBITED**. Do not read, list, search, or use any contact data. Treat the connector as OFF even if the UI shows it as available.
2) Gmail — **PROHIBITED**. Drafts may be produced as files only (CSV/MD/TXT). No sends, no mailbox reads.
3) Calendar — OFF unless explicitly requested for read‑only reference (never write). 
4) Drive — ON within the /Your Friend Logan/ChatGPT_Assets/ subtree, read‑only unless a write path is explicitly requested and documented.

Run‑time gates (must pass each run)
- CG‑1: Assistant must declare “Contacts=0 calls; Gmail=0 calls” in a Connector‑Usage Manifest at the end of every run.
- CG‑2: Any attempt to call Contacts or Gmail must STOP with a FAIL_CARD (no retries) and list the offending call.

Ethics & privacy
- No PII harvesting. Do not enrich or infer personal attributes. Draft outreach only; no direct messaging.

Why these rules (project history)
- 3.x series established “drafts only,” Finance OFF by default, and read‑only connectors, which we continue here. 
