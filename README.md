# Netflix Nostalgia Lab

Mini web para una propuesta a Netflix: usuarios de 25 a 35 anos suben ideas nostalgicas, comparten el enlace y votan por remasters, live actions o nuevas temporadas.

## Ejecutar

```bash
npm install
npm start
```

Abre `http://localhost:3000`.

## Persistencia

La app no usa `localStorage`.

En local guarda en SQLite:

- Base de datos: `data/netflix-nostalgia.db`
- Votos duplicados: se bloquean por cookie `voter_id`

En produccion usa Postgres si defines `DATABASE_URL`. Asi todas las personas ven las mismas propuestas y votos desde cualquier pais. Las imagenes subidas se guardan como datos en la base para no depender del disco temporal de Vercel.

Puedes usar una base Postgres de Supabase, Neon o cualquier proveedor compatible.

## Variables

Copia `.env.example` si quieres ajustar:

```bash
PORT=3000
PUBLIC_BASE_URL=https://tu-dominio.com
MAX_UPLOAD_MB=3
DATABASE_URL=postgresql://usuario:password@host:5432/database
```

En Vercel agrega `DATABASE_URL` en Project Settings > Environment Variables y vuelve a desplegar.
# netflix-tetr
