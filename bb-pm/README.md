# BB Project Management (React + Node)

SPA React + Fastify API + Postgres độc lập. Backend cho PM Operations Agent.

**Quick start:**
```bash
docker compose up bb_pm_db -d
pnpm install
pnpm --filter @bb-pm/api prisma migrate deploy
pnpm --filter @bb-pm/api prisma db seed
pnpm dev
```

- Web: http://localhost:5173
- API: http://localhost:4000
- DB:  localhost:5433

Login mặc định: `admin@bluebolt.local` / `admin123`

Xem:
- [ARCHITECTURE.md](./ARCHITECTURE.md) — thiết kế tổng thể
- [WALKTHROUGH.md](./WALKTHROUGH.md) — step-by-step setup
