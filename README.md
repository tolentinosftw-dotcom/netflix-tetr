# Netflix Nostalgia Lab

Mini web para una propuesta a Netflix: usuarios de 25 a 35 anos suben ideas nostalgicas, comparten el enlace y votan por remasters, live actions o nuevas temporadas.

## Ejecutar

```bash
npm install
npm start
```

Abre `http://localhost:3000`.

## Persistencia

La app no usa `localStorage`. Guarda propuestas, votos e imagenes en el servidor:

- Base de datos: `data/netflix-nostalgia.db`
- Imagenes subidas: `uploads/`
- Votos duplicados: se bloquean por cookie `voter_id`

Para produccion, despliegala en un servidor con disco persistente o conecta estas dos rutas a volumen persistente. Si se despliega en serverless, conviene migrar SQLite a Postgres y las imagenes a S3/R2.

## Variables

Copia `.env.example` si quieres ajustar:

```bash
PORT=3000
PUBLIC_BASE_URL=https://tu-dominio.com
MAX_UPLOAD_MB=5
```
# netflix-tetr
