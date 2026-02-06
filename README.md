# rastreo_guias_colombia

API en Node.js + Express para rastrear envios en:
- Coordinadora
- Interrapidisimo
- Servientrega

## Requisitos
- Node.js 18+ (recomendado 20+)
- Playwright (descarga de browsers)

## Instalacion
```bash
npm install
npx playwright install
```

## Ejecutar local
```bash
npm start
```

## Variables de entorno
Puedes crear un archivo `.env` usando el ejemplo:

```
PORT=3000
TRACK_TIMEOUT_MS=30000
TRACK_CACHE_TTL_MS=300000
```

## Uso
Endpoint:
```
POST /tracking
```
Body JSON:
```json
{
  "guia": "95201092951",
  "transportadora": "coordinadora"
}
```

### Transportadoras soportadas
- `coordinadora`
- `interrapidisimo`
- `servientrega`

### Ejemplos curl
```bash
curl -X POST http://localhost:3000/tracking \
  -H "Content-Type: application/json" \
  -d '{"guia":"95201092951","transportadora":"coordinadora"}'
```

```bash
curl -X POST http://localhost:3000/tracking \
  -H "Content-Type: application/json" \
  -d '{"guia":"700182784872","transportadora":"interrapidisimo"}'
```

```bash
curl -X POST http://localhost:3000/tracking \
  -H "Content-Type: application/json" \
  -d '{"guia":"2174740764","transportadora":"servientrega"}'
```

### Flags opcionales
- `debug: true` guarda `screenshot` y `html` en `/tmp` si falla.
- `raw: true` incluye texto completo sin parsear.
- `lines: true` incluye lineas parseadas en `parsed.lineas`.

## Docker
```bash
docker build -t rastreo_guias_colombia .
docker run -p 3000:3000 \
  -e PORT=3000 \
  -e TRACK_TIMEOUT_MS=30000 \
  -e TRACK_CACHE_TTL_MS=300000 \
  rastreo_guias_colombia
```

## Produccion (PM2)
```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```
