<<<<<<< HEAD
# surveyly
=======
# Surveyly+

Modern, full‑stack survey application with Supabase‑backed storage for responses, suggestions, version history, and admin operations. The frontend is a single page app served by a lightweight Node.js server.

## Features

- Supabase persistence for survey responses, suggestions, form counts, and version history
- Client initializes Supabase from server‑provided env (`/env.json`), no secrets in the browser
- Base questions are auto‑seeded if missing
- Suggestions moderation with red/green markers; server‑side admin deletion
- Version history snapshots saved to Supabase; server‑side deletion
- Results and charts hydrated from Supabase aggregates

## Quick Start

1. Prerequisites
   - Node.js 18+
   - A Supabase project

2. Configure database
   - Open your Supabase SQL editor and run the schema in `supabase_schema.sql` from the project root.
   - Ensure tables exist: `survey_questions`, `survey_responses`, `suggestions`, `form_stats`, `version_history`, `question_bank`.

3. Configure environment variables
   - Copy `.env.example` to `.env` and set values:

```env
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_ANON_KEY=your-anon-key-here
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
ADMIN_PASSWORD=your-admin-password
PORT=8081
```

   - `SUPABASE_URL` and `SUPABASE_ANON_KEY` are exposed to the client via `/env.json`.
   - `SUPABASE_SERVICE_ROLE_KEY` and `ADMIN_PASSWORD` are server‑only (used for admin deletion).

4. Install and run
   - Install dependencies: `npm install`
   - Start server: `node server.js`
   - Open: `http://localhost:8081/`

## How It Works

### Server (`server.js`)

- Serves static assets for the SPA
- Exposes `GET /env.json` with `SUPABASE_URL` and `SUPABASE_ANON_KEY` for the browser
- Provides `POST /admin/delete` for admin deletion (protected by `ADMIN_PASSWORD`) and uses `SUPABASE_SERVICE_ROLE_KEY` to delete records in allowed tables:
  - `survey_questions`, `survey_responses`, `suggestions`, `question_bank`, `version_history`

### Client (`script.js`)

- `initSupabaseClient` fetches `/env.json` and creates the Supabase client
- `ensureBaseQuestions` inserts predefined base questions in `survey_questions` if they do not exist
- `hydrateFromSupabase` aggregates answers from `survey_responses` to populate UI counts and then updates charts
- Form submissions:
  - Inserts answers into `survey_responses`
  - Inserts suggestions into `suggestions`
  - Increments form count in `form_stats`
- Suggestions moderation:
  - Red/green markers set `suggestions.status` (e.g., `flagged`/`approved`)
  - Delete suggestion triggers `POST /admin/delete` with the server performing verified deletion
- Version history:
  - `saveVersion` writes snapshot JSON to `version_history`
  - `loadVersionHistory` fetches and renders snapshots
  - `deleteVersion` calls `POST /admin/delete` to remove a snapshot server‑side

## Configuration

- `.env` (main configuration)
  - `SUPABASE_URL`: Supabase project URL
  - `SUPABASE_ANON_KEY`: anon key for client operations
  - `SUPABASE_SERVICE_ROLE_KEY`: service role for admin deletes
  - `ADMIN_PASSWORD`: password required by `/admin/delete`
  - `PORT`: server port (default `8081`)
- `.env.example` provides a template

## Database Schema (Overview)

While exact columns are defined in `supabase_schema.sql`, the app expects these tables:

- `survey_questions`
  - `id` (PK), `code`, `text`, `type`, `created_at`
- `survey_responses`
  - `id` (PK), `question_id` (FK), `answer_value` (number/string), `created_at`
- `suggestions`
  - `id` (PK), `text`, `reason`, `status` (e.g., `pending`, `flagged`, `approved`), `created_at`
- `form_stats`
  - `id` (PK), `submitted_at`
- `version_history`
  - `id` (PK), `snapshot` (JSON), `created_at`
- `question_bank`
  - `id` (PK), `code`, `text`, `type`, `created_at`

Note: Ensure appropriate Row Level Security (RLS) policies. The client needs `select`/`insert` for non‑admin tables. Admin deletes are server‑only.

## Usage

- First run will seed base questions if they do not exist.
- Submitting the survey will:
  - Insert responses and suggestions
  - Increment the form count
  - Refresh charts from Supabase aggregates
- Suggestions moderation:
  - Click red/green markers to set status
  - Use delete to remove via server (admin password required)
- Version history:
  - Save snapshots, view list, delete via admin endpoint

## Troubleshooting

- `net::ERR_ABORTED` or 401/403 from Supabase
  - Check `.env` credentials and restart the server
  - Ensure RLS policies permit `select` and `insert` for anonymous clients where needed
- Counts not updating
  - Verify `hydrateFromSupabase` succeeds (check console/network)
  - Confirm `survey_responses` rows are being written
- Admin delete fails
  - Confirm `ADMIN_PASSWORD` matches `.env`
  - Ensure the ID and `table` in request are valid and allowed by the server

## Development

- Start locally: `node server.js` then visit `http://localhost:8081/`
- Edit `script.js` for client behavior and Supabase queries
- Edit `server.js` for server routes and env handling

## Deployment

- Host the Node server on your platform of choice
- Provide production `.env` values securely
- Ensure Supabase RLS policies and keys are set for production

## License

Proprietary project. No explicit license included.
>>>>>>> 2e9d852 (Added .gitignore and removed node_modules from repo)
