# Microservicio SUNAT — SEE Del Contribuyente

Emisión electrónica multitenant para Perú: genera el XML **UBL 2.1**, lo firma con
**XMLDSig (RSA-SHA256)**, lo transmite a SUNAT (SOAP para CPE, REST para las guías),
procesa la **CDR** y produce la representación impresa en **PDF con QR**.

Los payloads siguen el formato de [Greenter](https://greenter.dev), el estándar de
facto en el ecosistema peruano: los mismos campos producen el mismo XML.

- **Stack:** Node.js 22 + TypeScript · Fastify · PostgreSQL · BullMQ/Redis · pdfkit
- **Manual de usuario:** repositorio [`sunat-docs`](https://github.com/carlosvidal/sunat-docs)
  (guías, casos de uso y referencia). Este README cubre el despliegue y la operación.
- **Comprobantes:** Factura (01), Boleta (03), Nota de Crédito (07), Nota de Débito (08),
  Retención (20), Percepción (40), Resumen Diario de Boletas (RC),
  Comunicación de Baja (RA), Guía de Remisión (GRE 2022)

---

## 1. Puesta en marcha

```bash
cp .env.example .env
# genera la llave de cifrado de secretos
openssl rand -base64 32     # -> SECRETS_MASTER_KEY

docker compose up -d        # PostgreSQL (5434) + Redis (6380)
pnpm install
pnpm migrate                # crea el esquema
pnpm dev                    # API      http://localhost:3000
pnpm dev:worker             # worker de la cola (opcional)
```

Producción:

```bash
pnpm build && pnpm start          # API
pnpm build && pnpm start:worker   # worker
```

Verificación: `curl localhost:3000/health`

| Interfaz | URL |
| --- | --- |
| Documentación interactiva (Swagger UI) | `http://localhost:3000/docs` |
| Especificación OpenAPI 3.0 | `http://localhost:3000/docs/json` |
| Backoffice de monitoreo | `http://localhost:3000/admin` |
| Payloads de ejemplo | `http://localhost:3000/api/v1/examples` |

---

## 2. Configuración

| Variable | Descripción |
| --- | --- |
| `MASTER_API_KEY` | Clave de la plataforma para administrar empresas (`X-API-Key`). |
| `JWT_SECRET` | Secreto con el que se firman los tokens por empresa. |
| `DATABASE_URL` | Cadena de conexión de PostgreSQL. |
| `REDIS_URL` | Habilita `/enqueue` y el worker. Si se omite, sólo hay emisión síncrona. |
| `SECRETS_DRIVER` | `local` (AES-256-GCM) o `kms` (punto de extensión para AWS KMS/Vault). |
| `SECRETS_MASTER_KEY` | 32 bytes en base64. Cifra contraseñas SOL y certificados. |
| `STORAGE_DRIVER` | `local` o `s3` (compatible con AWS S3 y Cloudflare R2). |
| `SUNAT_TIMEOUT_MS` | Timeout por llamada a SUNAT (por defecto 45 s). |
| `WEBHOOK_URL` / `WEBHOOK_SECRET` | Webhook por defecto; cada empresa puede tener el suyo. |

---

## 3. Autenticación

Dos niveles:

1. **Clave maestra** (`X-API-Key: $MASTER_API_KEY`) → administrar empresas.
2. **Token por empresa** (`Authorization: Bearer <token>`) → emitir. Se entrega al
   crear la empresa y no expira; puede reemitirse con `POST /companies/:id/token`.

---

## 4. API

Base: `/api/v1`

### Empresas (clave maestra)

| Método | Ruta | Descripción |
| --- | --- | --- |
| `POST` | `/companies` | Alta/actualización de empresa (idempotente por `tenant_id`). Devuelve el token. |
| `GET` | `/companies` · `/companies/:id` | Consulta. Nunca expone secretos. |
| `POST` | `/companies/:id/token` | Reemite el token de emisión. |
| `DELETE` | `/companies/:id` | Baja. |
| `POST` | `/companies/certificate/inspect` | Valida un `.pfx`/PEM y muestra vigencia y RUC. |
| `POST` | `/companies/certificate/free` | Certificado autofirmado para pruebas en BETA. |

```bash
curl -X POST localhost:3000/api/v1/companies \
  -H "x-api-key: $MASTER_API_KEY" -H 'content-type: application/json' -d '{
    "tenant_id": "tienda-123",
    "ruc": "20000000001",
    "razon_social": "MI EMPRESA S.A.C.",
    "domicilio_fiscal": { "ubigueo":"150101","direccion":"AV. LIMA 100",
                          "departamento":"LIMA","provincia":"LIMA","distrito":"LIMA" },
    "sol_user": "MODDATOS", "sol_pass": "MODDATOS",
    "certificado": "<pfx en base64>", "cert_password": "clave",
    "environment": "beta"
  }'
```

### Comprobantes (token de empresa)

| Método | Ruta | Descripción |
| --- | --- | --- |
| `POST` | `/invoice/send` · `/note/send` | Emisión **síncrona**: firma, envía y devuelve la CDR. |
| `POST` | `/invoice/enqueue` · `/note/enqueue` | Emisión **asíncrona** (BullMQ). Responde `202` con `jobId`. |
| `POST` | `/invoice/xml` · `/note/xml` | XML firmado, sin enviar. |
| `POST` | `/invoice/pdf?formato=a4\|ticket` | Representación impresa con QR. |
| `GET` | `/invoice/status?tipo=&serie=&numero=` | Estado local + CDR consultada en SUNAT. |
| `POST` | `/summary/send` · `/voided/send` | Resumen diario (RC) y baja (RA). Devuelven `ticket`. |
| `GET` | `/summary/status?ticket=` · `/voided/status?ticket=` | Resultado del ticket. |
| `POST` | `/despatch/send` · `/despatch/xml` | Guía de Remisión (GRE 2022, API REST). |
| `GET` | `/despatch/status?ticket=` | Resultado del ticket de la guía. |
| `POST` | `/retention/send` · `/perception/send` | Retención (20) y Percepción (40). Devuelven la CDR. |
| `POST` | `/retention/xml` · `/retention/pdf` | XML firmado y representación impresa (ídem `/perception/*`). |
| `GET` | `/documents` | Histórico con filtros (`state`, `desde`, `hasta`, `limit`, `offset`). |
| `GET` | `/documents/:id` · `/documents/:id/{xml\|cdr\|pdf}` | Detalle y descarga de artefactos. |

### Ejemplos (público)

| Método | Ruta | Descripción |
| --- | --- | --- |
| `GET` | `/examples` | Catálogo de payloads listos para copiar. |
| `GET` | `/examples/:nombre` | Un ejemplo puntual (`factura_detraccion`, `boleta`, `guia`…). |

### Backoffice (clave maestra)

| Método | Ruta | Descripción |
| --- | --- | --- |
| `GET` | `/admin/overview` | Totales por estado y tipo, últimos errores, empresas y resúmenes. |
| `GET` | `/admin/documents` | Búsqueda transversal a todas las empresas (estado, tipo, fechas, texto libre). |
| `GET` | `/admin/documents/:id` | Detalle con el payload original con el que se emitió. |
| `GET` | `/admin/documents/:id/{xml\|cdr\|pdf}` | Descarga de artefactos. |
| `POST` | `/admin/documents/:id/retry` | Reenvía a SUNAT reutilizando el mismo correlativo. `?async=true` lo encola. |
| `GET` | `/admin/queue` | Conteos de BullMQ y trabajos fallidos con su motivo. |
| `POST` | `/admin/queue/jobs/:jobId/retry` | Reencola un trabajo fallido. |

Ejemplo mínimo — el servicio calcula IGV, totales y la leyenda del monto en letras:

```bash
curl -X POST localhost:3000/api/v1/invoice/send \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
    "tipoDoc": "01", "serie": "F001",
    "client": { "tipoDoc":"6","numDoc":"20000000002","rznSocial":"CLIENTE S.A.C." },
    "details": [
      { "codProducto":"P001","unidad":"NIU","descripcion":"PRODUCTO 1",
        "cantidad":2,"mtoValorUnitario":100 }
    ]
  }'
```

```json
{
  "documentId": "40001615-8219-448c-b674-dd1f6ba8c8bf",
  "state": "ACEPTADO",
  "hash": "3fe8bIdB0FWem69ch6wmkdEwKPL/FOj2RXQSeFhOdRc=",
  "sunatResponse": {
    "success": true,
    "cdrResponse": { "id":"F001-1","code":"0","description":"La Factura numero F001-1, ha sido aceptada","notes":[],"accepted":true }
  },
  "files": { "xml":"...", "cdr":"...", "pdf":"..." }
}
```

Si se omite `correlativo`, el servicio reserva el siguiente de la serie de forma
atómica (`INSERT ... ON CONFLICT DO UPDATE ... RETURNING` sobre `document_series`),
lo que evita numeración duplicada bajo concurrencia. Si se envía, se respeta y el
contador se sincroniza al mayor valor visto.

---

## 5. Documentación y backoffice

**`/docs`** — Swagger UI generado desde los mismos esquemas zod que validan las
peticiones, así que no puede quedar desactualizado respecto al código. Cada
endpoint trae un payload de ejemplo ejecutable con *Try it out*. La
especificación cruda está en `/docs/json` y sirve para generar clientes
(`openapi-generator`, `orval`, etc.).

Los esquemas declarados en las rutas son **sólo documentación**: la validación
real la hace zod dentro de cada handler, porque acepta coerciones (RUC como
número, importes como string) que un JSON Schema estricto rechazaría.

**`/admin`** — backoffice de una sola página, sin build ni dependencias. Se
autentica con la clave maestra y permite:

- Tablero con comprobantes por estado, tasa de aceptación y monto aceptado.
- Búsqueda transversal a todas las empresas por serie-correlativo, RUC o cliente,
  con filtros de estado, tipo y rango de fechas.
- Detalle de cada comprobante: respuesta de SUNAT, observaciones, último error,
  payload original y descarga de XML, CDR y PDF.
- **Reintento manual** de un comprobante en `EXCEPCION` o `RECHAZADO`, que
  reutiliza el correlativo ya reservado (no consume uno nuevo). Disponible para
  facturas, boletas, notas, retenciones y percepciones.
- Estado de la cola BullMQ y reintento de trabajos fallidos.
- Vigencia del certificado digital de cada empresa.

---

## 6. Estados

| Estado | Significado |
| --- | --- |
| `PENDIENTE` | Registrado, aún sin firmar/enviar. |
| `EN_COLA_SUNAT` | Firmado y en tránsito (o esperando el ticket). |
| `ACEPTADO` | CDR con código `0`. |
| `ACEPTADO_CON_OBSERVACIONES` | CDR con código ≥ `4000`. |
| `RECHAZADO` | CDR/Fault entre `2000` y `3999`: **no se reintenta**, hay que corregir y reemitir. |
| `EXCEPCION` | Timeout o error de servicio (`0100`–`1999`): **se reintenta**. |

El worker aplica backoff de **1 min → 5 min → 15 min** (4 intentos) y sólo reintenta
lo que es reintentable; un rechazo de SUNAT nunca se reenvía.

---

## 7. Webhooks

Al terminar un job, el worker notifica a `webhook_url` (de la empresa o global) con
la firma HMAC-SHA256 del cuerpo en la cabecera `X-Signature`:

```json
{ "event":"cpe.aceptado", "tenant_id":"tienda-123", "ruc":"20000000001",
  "document_id":"…", "comprobante":"20000000001-01-F001-1",
  "state":"ACEPTADO", "code":"0", "description":"…ha sido aceptada" }
```

Eventos: `cpe.aceptado`, `cpe.rechazado`, `cpe.excepcion`, `resumen.procesado`.

---

## 8. Seguridad

- Contraseñas SOL, contraseña del certificado y `client_id/secret` se cifran con
  **AES-256-GCM** antes de tocar la base de datos; el `.pfx` se guarda cifrado en el
  storage. La interfaz `SecretVault` permite sustituir el driver por AWS KMS o Vault.
- El certificado se descifra **en memoria** por job (`node-forge`); nunca se escribe
  en claro a disco ni se cachea entre tenants.
- Todo acceso a documentos verifica que el `tenant_id` del token coincida con el del
  registro; el RUC del payload debe coincidir con el de la empresa autenticada.
- Los logs redactan `authorization`, `x-api-key`, `sol_pass`, `certificado`,
  `cert_password` y `client_secret`.
- El backoffice y la administración de empresas exigen la clave maestra; el
  navegador la guarda en `localStorage` y nunca viaja en la URL. Publíquelo sólo
  en una red interna o detrás de un proxy con autenticación adicional.

---

## 9. Arquitectura

```
Backend SaaS ──POST /invoice/send────────────► API (Fastify) ──► SUNAT (SOAP)  ──► CDR
             └─POST /invoice/enqueue──► Redis ──► Worker ──────► SUNAT         ──► CDR ──► webhook
                                                    │
                                          PostgreSQL (correlativos, estados)
                                          Storage    (XML, CDR .zip, PDF)
```

```
src/
  domain/      esquemas de entrada (zod), catálogos SUNAT y cálculo de totales
  ubl/         generadores XML (venta, resumen, baja, guía, retención/percepción) y firma XMLDSig
  sunat/       cliente SOAP, cliente REST GRE, parser de CDR, códigos de error
  security/    bóveda de secretos y manejo de certificados PKCS#12
  repositories/ tenants, documentos y correlativos
  services/    orquestación de la emisión, QR, webhooks
  pdf/         representación impresa (A4 y ticket 80 mm)
  http/        rutas, autenticación, OpenAPI y backoffice (backoffice.html)
  queue/       cola BullMQ · worker.ts    proceso de reintentos
```

---

## 10. Pruebas

```bash
pnpm test        # 35 pruebas: totales, UBL, firma, CDR, certificados, cifrado
pnpm typecheck
```

Validado de extremo a extremo contra el ambiente **BETA de SUNAT**
(RUC `20000000001`, usuario `MODDATOS`). Todos los envíos devolvieron código `0`:

| Tipo | Casos aceptados por SUNAT |
| --- | --- |
| Factura (01) | gravada · exonerada · gratuita · descuento global · descuento por línea · percepción · anticipos · detracción · exportación · ICBPER · ISC · IVAP · contingencia · compleja (5 afectaciones) |
| Boleta (03) | gravada · con ICBPER |
| Notas (07, 08) | crédito sobre factura · crédito sobre boleta · débito por intereses |
| Retención (20) · Percepción (40) | con pagos y detalle de documentos afectados |
| Resumen (RC) | normal · de contingencia · en dólares · con notas que afectan boletas |
| Baja (RA) | aceptada con ticket |

También verificados: emisión asíncrona por el worker, y reintento desde el
backoffice recuperando un comprobante que había fallado.

Para probar sin certificado propio:

```bash
curl -X POST localhost:3000/api/v1/companies/certificate/free \
  -H "x-api-key: $MASTER_API_KEY" -H 'content-type: application/json' \
  -d '{"ruc":"20000000001","razon_social":"EMPRESA DEMO","password":"demo123"}'
```

---

## 11. Notas operativas

- **Ambiente BETA de SUNAT:** `getStatus` (consulta de tickets) está caído del lado
  de SUNAT y responde `Fault Server.200 — Failed to establish a backside connection`.
  Por eso los resúmenes y bajas quedan en `EN_COLA_SUNAT` en beta aunque el envío
  haya sido aceptado; en producción el servicio sí responde. El cliente lo trata
  como error de transporte reintentable (`503`) y el worker reprograma la consulta.
- Beta también devuelve `401 Authorization Required` de forma intermitente en
  envíos válidos; se clasifica igualmente como reintentable.
- **Nueva GRE:** requiere `client_id`/`client_secret` generados en el portal SOL. Sin
  ellos, `/despatch/send` responde `400` sin consumir correlativo.
- **Retención y percepción:** viajan por el web service de *otros comprobantes*
  (`ol-ti-itemision-otroscpe-gem`), no por el de facturas. Los importes retenidos o
  percibidos siempre se declaran en soles, aunque el documento de origen esté en
  otra moneda (para eso está `tipoCambio`). El emisor debe estar designado por
  SUNAT como agente de retención o percepción.
- **Producción:** cambiar `environment` a `produccion` en la empresa; el certificado
  debe ser uno emitido por una entidad autorizada (no autofirmado).

---

## Créditos

La estructura de los XML UBL 2.1 se contrastó con las plantillas de
[Greenter](https://github.com/thegreenter/xml) (MIT), el proyecto de referencia para
facturación electrónica peruana. El formato de los payloads mantiene esa
compatibilidad a propósito.

Ante cualquier discrepancia entre una plantilla de referencia y lo que responde el
web service, manda SUNAT: este servicio incorpora varias correcciones descubiertas
emitiendo contra el ambiente real.

## Licencia

[MIT](LICENSE) © Carlos Vidal

Este software se distribuye tal cual. La responsabilidad tributaria de los
comprobantes emitidos es siempre del contribuyente emisor.
