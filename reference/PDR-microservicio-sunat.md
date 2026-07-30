# PDR-001: Microservicio de Emisión Electrónica SUNAT (SEE - Del Contribuyente)

| Meta | Detalle |
| --- | --- |
| **Estado** | Aprobado / Especificación Técnica |
| **Dominio** | Billing / Facturación Electrónica (Perú) |
| **Arquitectura** | Microservicio REST/gRPC Multitenant desacoplado |
| **Modalidad** | SEE – Del Contribuyente (Envío directo a SUNAT via Web Services) |
| **Stack Principal** | Node.js (TypeScript), Fastify, BullMQ, PostgreSQL, AWS KMS, S3 |

---

## 1. Contexto y Objetivos

### 1.1 Contexto
Plataforma SaaS Multitenant donde cada *tenant* (empresa cliente) emite sus propios Comprobantes de Pago Electrónicos (CPE) a la **SUNAT** con su propio RUC, Certificado Digital y series correlativas independientes.

### 1.2 Objetivos Principales
* **Aislamiento Multitenant:** Garantizar que las llaves privadas, certificados digital (.pfx) y credenciales SOL de cada *tenant* estén rigurosamente segregados y cifrados en reposo y tránsito.
* **Procesamiento Asíncrono:** La emisión no debe bloquear el flujo de venta ni la experiencia de usuario en el backend principal del SaaS.
* **Resiliencia ante SUNAT:** Gestionar caídas o latencias extremas de las APIs/Web Services de SUNAT mediante colas con reintentos exponenciales.
* **Estandarización JSON:** Exponer una API limpia en JSON para el SaaS, abstrayendo la complejidad de las estructuras XML UBL 2.1, firmado digital XMLDSig y protocolos SOAP/REST.

---

## 2. Stack Tecnológico Recomendado y Enlaces Oficiales

Para maximizar el rendimiento, la velocidad de desarrollo y la seguridad criptográfica, se define el siguiente stack tecnológico:

### 2.1 Core del Microservicio
* **Lenguaje & Runtime:** [Node.js](https://nodejs.org/) (TypeScript)
* **Framework HTTP:** [Fastify](https://fastify.dev/) (Alta velocidad, bajo overhead en comparación con Express/NestJS).
* **Gestión de Colas & Workers:** [BullMQ](https://bullmq.io/) sobre [Redis](https://redis.io/) (Manejo de reintentos exponenciales, aislamiento de trabajos y alto rendimiento).
* **Base de Datos Relacional:** [PostgreSQL](https://www.postgresql.org/) (Integridad transaccional y bloqueos para correlativos).
* **Almacenamiento de Artefactos:** [AWS S3](https://aws.amazon.com/s3/) / [Cloudflare R2](https://www.cloudflare.com/developer-platform/r2/) (Almacenamiento masivo de XML, CDR `.zip` y PDF).

### 2.2 Seguridad y Criptografía
* **Bóveda de Claves:** [AWS KMS](https://aws.amazon.com/kms/) o [HashiCorp Vault](https://www.vaultproject.io/) (Cifrado de credenciales SOL y Certificados Digitales con algoritmo AES-256).
* **Manipulación de Certificados PFX:** [node-forge](https://github.com/digitalbazaar/forge) (Lectura y extracción de llaves públicas/privadas del `.pfx` directamente en memoria).
* **Firma Digital XMLDSig:** [xml-crypto](https://github.com/node-saml/xml-crypto) & [xmldom](https://github.com/xmldom/xmldom) (Firma digital de documentos XML bajo el estándar W3C exigido por SUNAT).

### 2.3 Formatos y Documentación Oficial SUNAT
* **Construcción XML UBL 2.1:** [xmlbuilder2](https://xmlbuilder2.github.io/) (Creación eficiente del árbol XML).
* **Generación de PDF & Código QR:** [Puppeteer](https://pptr.dev/) (Renderizado de plantillas HTML/CSS a PDF) y [node-qrcode](https://github.com/soldair/node-qrcode) (Generación de matriz QR).
* **Documentación Oficial SUNAT:**
  * [Portal SUNAT - Facturación Electrónica](https://cpe.sunat.gob.pe/)
  * [Especificaciones Técnicas UBL 2.1 y Anexos SUNAT](https://cpe.sunat.gob.pe/desarrolladores/especificaciones_tecnicas)
  * [Estándar OASIS UBL 2.1](https://docs.oasis-open.org/ubl/os-UBL-2.1/UBL-2.1.html)

---

## 3. Requisitos Funcionales

* **RF-01: Gestión de Credenciales por Tenant:** Almacenar de forma segura el Certificado Digital (`.pfx` / `.p12`), clave del certificado, Usuario SOL Secundario y `Client ID / Client Secret` de SUNAT por cada *tenant*.
* **RF-02: Generación XML (UBL 2.1):** Construir la estructura XML bajo la normativa vigente de SUNAT para:
  * Facturas (`01`) y Boletas de Venta (`03`).
  * Notas de Crédito (`07`) y Notas de Débito (`08`).
  * Guías de Remisión Remitente (`09` - vía API REST SUNAT).
* **RF-03: Firmado Digital:** Aplicar la firma digital XMLDSig (algoritmo SHA-256 / RSA) usando el certificado del *tenant* en memoria sin persistir claves en disco sin cifrar.
* **RF-04: Transmisión y Recepción CDR:** Comprimir en `.zip`, transmitir vía SOAP/REST a SUNAT, recibir y almacenar la **CDR** (Constancia de Recepción) y parsear estados (Aceptado, Rechazado, Excepciones).
* **RF-05: Generación de PDF/QR:** Producir la representación impresa en PDF incluyendo el Código QR normativo.
* **RF-06: Gestión de Correlativos:** Control de series (`F001`, `B001`, etc.) y números correlativos por *tenant*, previniendo duplicidades mediante locks de base de datos.

---

## 4. Arquitectura y Diseño Técnico

### 4.1 Flujo de Información

```
[ Backend SaaS ] ──(1. POST JSON /emision)──> [ API Ingestion (Fastify) ]
                                                      │
                                           (2. Encola Job en BullMQ)
                                                      │
                                                      v
                                            [ Worker Queue (Redis) ]
                                                      │
                                           (3. Descarga PFX en Memoria)
                                           (4. Genera XML + Firma SHA256)
                                                      │
                                                      v
                                            [ SOAP Client HTTPS ]
                                                      │
                                                      v
                                                [ SUNAT API ]
                                                      │
                                           (5. Retorna CDR / Respuesta)
                                                      v
[ Backend SaaS ] <──(6. Webhook / Evento)─── [ Worker Processing ]
```

### 4.2 Proceso Detallado del Worker

1. Descarga & Decodifica PFX en Memoria (KMS / node-forge).
2. Construye XML UBL 2.1 (xmlbuilder2).
3. Firma XML (xml-crypto) & Empaqueta en .ZIP.
4. Envía vía SOAP a WebService SUNAT.
5. Procesa CDR (Aceptado/Rechazado).
6. Genera PDF (Puppeteer) + QR y guarda en S3.

---

## 5. Diseño de Base de Datos (PostgreSQL Multitenant)

### 5.1 Tabla: `tenant_sunat_profiles`
```sql
CREATE TABLE tenant_sunat_profiles (
    tenant_id VARCHAR(36) PRIMARY KEY,
    ruc VARCHAR(11) NOT NULL UNIQUE,
    razon_social VARCHAR(255) NOT NULL,
    sol_user VARCHAR(50) NOT NULL,            -- Usuario secundario SOL
    sol_pass_encrypted TEXT NOT NULL,         -- Cifrado AES-256 (KMS)
    cert_pfx_blob_path VARCHAR(500) NOT NULL,  -- Ruta segura en S3
    cert_password_encrypted TEXT NOT NULL,    -- Cifrado AES-256 (KMS)
    client_id_encrypted TEXT NULL,            -- API REST SUNAT (Guías)
    client_secret_encrypted TEXT NULL,
    ambiente VARCHAR(10) DEFAULT 'BETA',      -- 'BETA' o 'PRODUCCION'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 5.2 Tabla: `electronic_documents`
```sql
CREATE TABLE electronic_documents (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id VARCHAR(36) NOT NULL,
    tipo_comprobante VARCHAR(2) NOT NULL,     -- '01', '03', '07', '08'
    serie VARCHAR(4) NOT NULL,
    correlativo INT NOT NULL,
    fecha_emision DATE NOT NULL,
    cliente_tipo_doc VARCHAR(1) NOT NULL,
    cliente_num_doc VARCHAR(15) NOT NULL,
    monto_total DECIMAL(12, 2) NOT NULL,
    
    -- Estados y trazabilidad
    sunat_state VARCHAR(20) NOT NULL,         -- 'PENDIENTE', 'ACEPTADO', 'RECHAZADO', 'EXCEPCION'
    sunat_code VARCHAR(10),                   -- Código de respuesta SUNAT (ej. '0')
    sunat_description TEXT,                   -- Ej. 'La Factura F001-452 ha sido aceptada'
    
    -- Ubicación de artefactos
    xml_path VARCHAR(500),
    cdr_path VARCHAR(500),
    pdf_path VARCHAR(500),
    
    digest_value VARCHAR(100),
    retry_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE (tenant_id, tipo_comprobante, serie, correlativo)
);
```

---

## 6. Especificación de la API (JSON Ingest)

Endpoint del Microservicio: `POST /api/v1/cpe/emitir`

```json
{
  "tenant_id": "tenant_uuid_9876",
  "comprobante": {
    "tipo": "01",
    "serie": "F001",
    "correlativo": 452,
    "fecha_emision": "2026-07-29",
    "moneda": "PEN",
    "cliente": {
      "tipo_doc": "6",
      "num_doc": "20601234567",
      "razon_social": "EMPRESA CLIENTE S.A.C.",
      "direccion": "Av. Javier Prado Este 123, Lima"
    },
    "totales": {
      "op_gravadas": 1000.00,
      "igv": 180.00,
      "total": 1180.00
    },
    "items": [
      {
        "codigo": "SERV-001",
        "descripcion": "Suscripción Software Plan Pro (Mes)",
        "cantidad": 1,
        "unidad_medida": "ZZ",
        "valor_unitario": 1000.00,
        "precio_unitario": 1180.00,
        "igv": 180.00,
        "tipo_afectacion_igv": "10"
      }
    ]
  }
}
```

---

## 7. Requisitos No Funcionales y Seguridad

### 7.1 Security & Compliance
1. **Cifrado de Secretos (KMS):** Las claves privadas y passwords SOL jamás se almacenan en texto plano en la base de datos. Se cifran mediante llaves rotativas de KMS (AWS KMS o HashiCorp Vault).
2. **Firmado In-Memory:** El archivo `.pfx` se descarga de S3 a la memoria volátil del proceso worker, se desencripta con `node-forge`, firma el XML y se elimina del Garbage Collector inmediatamente.
3. **Multi-tenancy Isolation:** Las tareas del Worker deben aislar los contextos de ejecución para evitar contaminación cruzada de certificados entre distintos tenants.

### 7.2 Desempeño y Resiliencia
1. **Queueing Strategy:** Todo envío a SUNAT se gestiona mediante BullMQ. SUNAT suele presentar latencias de 2 a 15 segundos por petición.
2. **Circuit Breaker & Exponential Backoff:** Si el Web Service de SUNAT responde con error 5xx o *Timeouts*, el sistema aplica retries exponenciales (1 min, 5 min, 15 min) marcando el comprobante en estado `EN_COLA_SUNAT` sin bloquear al usuario final.
