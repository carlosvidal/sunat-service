# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repositorio

Microservicio de emisión electrónica SUNAT (Node 22 + TypeScript + Fastify). El
manual de usuario vive en un repositorio aparte (`sunat-docs`, VitePress).

En `reference/PDR-microservicio-sunat.md` está la especificación original del
servicio.

## Comandos

Todo con **pnpm** (npm está redirigido a pnpm por corepack en este entorno).

```bash
pnpm migrate                 # crea/actualiza el esquema (idempotente)
pnpm dev                     # API con --watch
pnpm dev:worker              # worker de la cola
pnpm test                    # 35 pruebas (node:test)
pnpm typecheck               # tsc --noEmit
pnpm build && pnpm start     # producción

# una sola prueba
node --experimental-strip-types --test --test-name-pattern 'percepción' tests/unit.test.ts
```

Infraestructura local: `docker compose up -d` levanta PostgreSQL (**5434**) y
Redis (**6380**).

## Restricciones del entorno

- **Sin transpilador.** Se ejecuta con `node --experimental-strip-types`, que solo
  borra tipos. Prohibido: *parameter properties* (`constructor(private x)`), `enum`,
  `namespace`. Los imports relativos llevan extensión **`.ts`**; `tsc` los reescribe a
  `.js` en el build (`rewriteRelativeImportExtensions`).
- **pnpm bloquea los scripts de instalación.** Si un paquete necesita su postinstall,
  hay que correr `pnpm approve-builds --all` una vez, o `pnpm exec` fallará con
  `ERR_PNPM_IGNORED_BUILDS`.

## Arquitectura

### Flujo de emisión

`payload JSON → zod → completarTotales → buildXml → signUbl → zip → SUNAT → CDR → storage`

Orquestado en `src/services/emitter.ts`, el archivo central. Cada tipo de comprobante
entra por una ruta distinta pero converge en el mismo pipeline:

| Capa | Dónde |
| --- | --- |
| Esquemas de entrada (zod) | `src/domain/schemas.ts` |
| Cálculo de importes | `src/domain/totals.ts` |
| Catálogos SUNAT | `src/domain/catalogs.ts` |
| Generadores XML | `src/ubl/{sale,summary,despatch,retention}.ts` |
| Firma XMLDSig | `src/ubl/sign.ts` |
| Transporte | `src/sunat/soap.ts` (CPE) · `src/sunat/gre.ts` (guías, REST + OAuth2) |
| Persistencia | `src/repositories/{tenants,documents}.ts` |

### Decisiones que hay que conocer antes de tocar código

**Los totales enviados nunca se sobrescriben.** `completarTotales` solo rellena lo
ausente. `validarTotales` compara la suma de líneas contra los totales declarados,
pero tolera la diferencia que descuentos globales, cargos y anticipos puedan explicar
(un descuento que afecta la base reduce `mtoOperGravadas` legítimamente).

**Los esquemas de las rutas son solo documentación.** `app.ts` instala un
`validatorCompiler` no-op: Fastify no valida. La validación real es zod dentro del
handler, porque acepta coerciones (RUC como número, importes como string) que un JSON
Schema estricto rechazaría. Si agregas una ruta, declara `schema` para que aparezca en
`/docs`, pero valida con zod en el handler.

**Correlativos.** `crearConCorrelativo` reserva el número con
`INSERT … ON CONFLICT DO UPDATE … RETURNING` sobre `document_series`, dentro de la
misma transacción que crea el documento. `siguienteCorrelativo` solo mira, sin
consumir: es para previsualizar en `/xml` y `/pdf`.

**Reintentos.** `esReintentable` en `src/sunat/errors.ts` decide: un rechazo de SUNAT
(`2000`–`3999`) **nunca** se reintenta porque el XML es inválido; un error de
transporte o de configuración (`0100`–`1999`, timeouts) sí. El worker aplica backoff
de 1, 5 y 15 minutos.

**Secretos.** Clave SOL, contraseña del certificado y `client_secret` se cifran con
AES-256-GCM (`src/security/secrets.ts`); el `.pfx` se guarda cifrado en el storage y
se descifra **por job**, en memoria, sin cachearse entre tenants (`loadSecrets`).

**Autenticación: tres niveles (multi-operador).** No hay una sola `MASTER_API_KEY`
para administrar empresas: la gestión está repartida en tres ámbitos
(`src/http/auth.ts`):

| Ámbito | Decorador | Cabecera | Rutas |
| --- | --- | --- | --- |
| Super-admin (plataforma) | `requireMasterKey` | `X-API-Key` | `/operators/*`, `/companies/:id/reassign`, `/admin/*` |
| Operador (PMS/ERP) | `requireOperator` | `X-Operator-Key` | `/companies/*` |
| Empresa | `requireTenant` | `Authorization: Bearer` | emisión y documentos |

- Un **operador** posee empresas (1:N) y se autentica con API keys opacas `skop_...`
  hasheadas con scrypt (`src/security/apikey.ts`, `src/repositories/operators.ts`).
  Cada operador puede tener **varias claves activas** → rotación con solapamiento.
- `POST /companies` asocia la empresa al operador autenticado; el `ON CONFLICT`
  **preserva** `operator_id` para evitar robo de empresas por `tenant_id` ajeno (la
  validación previa en el handler devuelve 409).
- Reasignar una empresa entre operadores es privilegio del super-admin
  (`POST /companies/:id/reassign`) y **no** cambia el JWT del tenant: el ERP del
  cliente final sigue emitiendo sin interrupción.

**Dos servicios SOAP distintos.** Facturas, boletas, notas, resúmenes y bajas van a
`cpe`; retenciones y percepciones a `otros` (`endpointFor` en `src/sunat/endpoints.ts`).
Las guías no usan SOAP sino la API REST con OAuth2.

## Reglas de SUNAT aprendidas contra el servicio real

Cada una costó un rechazo y tiene una prueba de regresión. No las cambies sin volver a
probar contra BETA:

- **Percepción en factura:** `perception.porcentaje` es un **factor** (`0.02` = 2 %),
  se escribe tal cual en `MultiplierFactorNumeric`. Dividirlo entre 100 → rechazo `2798`.
- **Resumen diario:** el ID `RC-AAAAMMDD-###` se arma con `fecResumen`, no con
  `fecGeneracion` → rechazo `2346`.
- **Percepción (comprobante 40):** el emisor va en `cac:AgentParty`, igual que la
  retención. Usar `cac:SellerSupplierParty` (como hace la plantilla de Greenter) →
  rechazo `0306`.
- **Orden de elementos:** los XSD de SUNAT lo exigen. En factura la firma va antes del
  emisor; en retención/percepción va antes del `cbc:ID`. Las pruebas verifican el orden
  con comparaciones de `indexOf`.

Las plantillas de [Greenter](https://github.com/thegreenter/xml) (`src/Xml/Templates/`)
son la referencia para la estructura UBL, pero **no son infalibles**: ante una
discrepancia, manda lo que responde SUNAT.

## Probar contra SUNAT

BETA acepta el RUC `20000000001` con usuario y clave `MODDATOS`. Para armar el
entorno: primero crea un operador y su API key con `POST /operators` +
`POST /operators/:id/keys` (super-admin), luego `POST /companies/certificate/free`
genera un certificado autofirmado válido solo en BETA, y `POST /companies`
(registrada con la API key del operador) registra la empresa y devuelve el token.

Los payloads de todos los casos ya verificados están en `GET /api/v1/examples`
(definidos en `src/http/examples.ts`).

Particularidades del ambiente de pruebas, que no son fallas del servicio: la consulta
de tickets (`getStatus`) responde `Failed to establish a backside connection`, y
aparecen `401` intermitentes en envíos válidos.

## Al agregar un tipo de comprobante

1. Esquema zod en `src/domain/schemas.ts`.
2. Generador en `src/ubl/`, reutilizando los helpers de `common.ts`.
3. Función de emisión en `src/services/emitter.ts`.
4. Rutas en `src/http/routes/`, registradas en `app.ts`, con `schema` para OpenAPI.
5. Ejemplo en `src/http/examples.ts` y en el catálogo de `examples-route.ts`.
6. Tipo de job en `src/queue/index.ts` y su caso en `src/worker.ts` si va por cola.
7. Prueba de estructura XML y envío real a BETA antes de dar por hecho que funciona.
8. Documentar en el repositorio `sunat-docs` y enlazarlo en la barra lateral de su
   `config.mts` (ese build falla si el enlace no existe).
