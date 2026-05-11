# Netflix Nostalgia Lab

Mini web app for a Netflix proposal: users ages 25 to 35 submit nostalgic ideas, share them, and vote for remasters, live actions, or new seasons.

## Run

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Persistence

The app does not use `localStorage`.

In local development it stores data in a JSON file:

- Local database: `data/local-store.json`
- Duplicate votes are blocked with the `voter_id` cookie

In production it uses Postgres when `DATABASE_URL` is defined. This lets people in different countries see the same proposals, votes, and ranking. Uploaded images are stored as data in the database so the app does not depend on Vercel's temporary filesystem.

You can use Supabase, Neon, or any Postgres-compatible provider.

## Variables

Copy `.env.example` if you want to customize:

```bash
PORT=3000
PUBLIC_BASE_URL=https://your-domain.com
MAX_UPLOAD_MB=3
DATABASE_URL=postgresql://user:password@host:5432/database
```

In Vercel, add `DATABASE_URL` in Project Settings > Environment Variables and redeploy.
