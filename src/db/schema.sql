-- Esquema del microservicio de emisión electrónica (SEE Del Contribuyente).

CREATE TABLE IF NOT EXISTS tenant_sunat_profiles (
    tenant_id               VARCHAR(64) PRIMARY KEY,
    ruc                     VARCHAR(11)  NOT NULL UNIQUE,
    razon_social            VARCHAR(255) NOT NULL,
    nombre_comercial        VARCHAR(255),
    domicilio_fiscal        JSONB        NOT NULL DEFAULT '{}'::jsonb,
    sol_user                VARCHAR(50)  NOT NULL,
    sol_pass_encrypted      TEXT         NOT NULL,
    cert_blob_path          VARCHAR(500) NOT NULL,
    cert_password_encrypted TEXT         NOT NULL,
    cert_valid_to           TIMESTAMPTZ,
    cert_subject            TEXT,
    client_id_encrypted     TEXT,
    client_secret_encrypted TEXT,
    ambiente                VARCHAR(12)  NOT NULL DEFAULT 'beta'
                              CHECK (ambiente IN ('beta', 'produccion')),
    webhook_url             VARCHAR(500),
    webhook_secret          TEXT,
    logo_path               VARCHAR(500),
    activo                  BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Correlativos por serie. El UPDATE ... RETURNING sobre esta fila es el lock
-- que evita numeración duplicada bajo concurrencia.
CREATE TABLE IF NOT EXISTS document_series (
    tenant_id        VARCHAR(64) NOT NULL REFERENCES tenant_sunat_profiles(tenant_id) ON DELETE CASCADE,
    tipo_comprobante VARCHAR(2)  NOT NULL,
    serie            VARCHAR(4)  NOT NULL,
    ultimo_numero    BIGINT      NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, tipo_comprobante, serie)
);

CREATE TABLE IF NOT EXISTS electronic_documents (
    id                  UUID PRIMARY KEY,
    tenant_id           VARCHAR(64)  NOT NULL REFERENCES tenant_sunat_profiles(tenant_id) ON DELETE CASCADE,
    tipo_comprobante    VARCHAR(2)   NOT NULL,
    serie               VARCHAR(4)   NOT NULL,
    correlativo         BIGINT       NOT NULL,
    nombre_archivo      VARCHAR(120) NOT NULL,
    fecha_emision       DATE         NOT NULL,
    cliente_tipo_doc    VARCHAR(1),
    cliente_num_doc     VARCHAR(15),
    cliente_razon_social VARCHAR(255),
    moneda              VARCHAR(3)   NOT NULL DEFAULT 'PEN',
    monto_total         NUMERIC(14, 2) NOT NULL DEFAULT 0,

    sunat_state         VARCHAR(20)  NOT NULL DEFAULT 'PENDIENTE'
                          CHECK (sunat_state IN ('PENDIENTE','EN_COLA_SUNAT','ACEPTADO','ACEPTADO_CON_OBSERVACIONES','RECHAZADO','EXCEPCION','ANULADO')),
    sunat_code          VARCHAR(10),
    sunat_description   TEXT,
    sunat_notes         JSONB,
    ticket              VARCHAR(60),

    xml_path            VARCHAR(500),
    cdr_path            VARCHAR(500),
    pdf_path            VARCHAR(500),

    digest_value        VARCHAR(120),
    payload             JSONB        NOT NULL,
    retry_count         INT          NOT NULL DEFAULT 0,
    last_error          TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    UNIQUE (tenant_id, tipo_comprobante, serie, correlativo)
);

CREATE INDEX IF NOT EXISTS idx_documents_tenant_state ON electronic_documents (tenant_id, sunat_state);
CREATE INDEX IF NOT EXISTS idx_documents_fecha ON electronic_documents (tenant_id, fecha_emision DESC);
CREATE INDEX IF NOT EXISTS idx_documents_ticket ON electronic_documents (ticket) WHERE ticket IS NOT NULL;

-- Resúmenes diarios (RC) y comunicaciones de baja (RA): se procesan por ticket.
CREATE TABLE IF NOT EXISTS summary_documents (
    id                UUID PRIMARY KEY,
    tenant_id         VARCHAR(64) NOT NULL REFERENCES tenant_sunat_profiles(tenant_id) ON DELETE CASCADE,
    tipo              VARCHAR(2)  NOT NULL CHECK (tipo IN ('RC','RA')),
    nombre_archivo    VARCHAR(120) NOT NULL,
    fecha_referencia  DATE        NOT NULL,
    ticket            VARCHAR(60),
    sunat_state       VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
    sunat_code        VARCHAR(10),
    sunat_description TEXT,
    sunat_notes       JSONB,
    xml_path          VARCHAR(500),
    cdr_path          VARCHAR(500),
    digest_value      VARCHAR(120),
    payload           JSONB       NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, nombre_archivo)
);
