--
-- PostgreSQL database dump
--

\restrict vgWq8arN7N83w0kEKiLpABlUYqvXffS8oPgwwgQoNrsnLLiAakk4XFmZgoWqcUD

-- Dumped from database version 18.3
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: dwh; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA dwh;


--
-- Name: SCHEMA dwh; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA dwh IS 'Data Warehouse. Tabele per-tenant z prefiksem slug tenanta, np. dwh.crmtree_gold_partner.';


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: access_level; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.access_level AS ENUM (
    'read',
    'full'
);


--
-- Name: audit_action; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.audit_action AS ENUM (
    'document_created',
    'document_updated',
    'document_deleted',
    'document_viewed',
    'document_downloaded',
    'metadata_updated',
    'tag_added',
    'tag_removed',
    'tag_updated',
    'status_changed',
    'workflow_task_created',
    'workflow_task_completed',
    'workflow_task_cancelled',
    'signing_initiated',
    'signing_completed',
    'signing_failed',
    'version_uploaded',
    'user_login',
    'user_logout',
    'user_created',
    'user_updated',
    'role_assigned',
    'role_removed',
    'group_created',
    'group_updated',
    'group_deleted',
    'doc_group_created',
    'doc_group_updated',
    'doc_group_deleted',
    'document_linked',
    'document_unlinked',
    'attachment_uploaded',
    'attachment_version_uploaded',
    'attachment_deleted',
    'crm_import_documents',
    'crm_lead_create',
    'crm_lead_update',
    'crm_lead_delete',
    'crm_lead_migrated',
    'crm_import_leads',
    'crm_import_partners',
    'crm_group_create',
    'crm_group_update',
    'crm_group_delete',
    'crm_partner_create',
    'crm_partner_update',
    'crm_partner_delete',
    'settings_updated',
    'crm_lead_test_account',
    'crm_activity_create',
    'crm_activity_update',
    'crm_activity_close',
    'crm_lead_converted',
    'user_password_set',
    'user_deleted',
    'crm_lead_consent_update',
    'crm_partner_consent_update'
);


--
-- Name: auth_provider_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.auth_provider_type AS ENUM (
    'password',
    'google_workspace',
    'entra_id',
    'saml'
);


--
-- Name: crm_feature_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.crm_feature_type AS ENUM (
    'documents',
    'leads',
    'sales_reports',
    'onboarding',
    'partner_registry',
    'dwh_integration',
    'performance'
);


--
-- Name: doc_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.doc_status AS ENUM (
    'new',
    'being_edited',
    'being_signed',
    'signed',
    'hold',
    'completed',
    'rejected',
    'being_approved'
);


--
-- Name: doc_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.doc_type AS ENUM (
    'partner_agreement',
    'it_supplier_agreement',
    'employee_agreement',
    'nda',
    'operator_agreement'
);


--
-- Name: gdpr_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.gdpr_type AS ENUM (
    'data_processing_entrustment',
    'data_administration',
    'no_gdpr'
);


--
-- Name: workflow_task_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.workflow_task_status AS ENUM (
    'pending',
    'in_progress',
    'completed',
    'cancelled'
);


--
-- Name: workflow_task_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.workflow_task_type AS ENUM (
    'read',
    'edit',
    'approve',
    'sign'
);


--
-- Name: generate_doc_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_doc_number() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_year  SMALLINT := EXTRACT(YEAR FROM NOW());
  v_seq   INTEGER;
BEGIN
  IF NEW.tenant_id IS NULL THEN
    RAISE EXCEPTION 'documents.tenant_id is required (cannot generate doc_number without tenant)';
  END IF;
  INSERT INTO doc_number_seq (tenant_id, year, last_n) VALUES (NEW.tenant_id, v_year, 1)
    ON CONFLICT (tenant_id, year) DO UPDATE SET last_n = doc_number_seq.last_n + 1
    RETURNING last_n INTO v_seq;
  NEW.doc_number := 'DOC-' || v_year || '-' || LPAD(v_seq::TEXT, 4, '0');
  RETURN NEW;
END;
$$;


--
-- Name: immutable_array_to_string(text[], text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.immutable_array_to_string(text[], text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $_$
  SELECT array_to_string($1, $2)
$_$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: brmtree_test1_partner; Type: TABLE; Schema: dwh; Owner: -
--

CREATE TABLE dwh.brmtree_test1_partner (
    partner_id integer,
    name character varying,
    subdomain character varying,
    domain character varying,
    config_json character varying,
    super_partner boolean,
    max_debit numeric(8,2),
    country character varying,
    default_price_from integer,
    default_price_to integer,
    currency character varying,
    self_registered boolean,
    partner_group character varying,
    is_test_account boolean,
    customer_service_note character varying,
    switched_to_prod_at timestamp without time zone,
    default_services_process_type character varying,
    is_contract_signed boolean,
    custom_contact_email character varying,
    partner_billing_address_id integer,
    company_name character varying,
    address character varying,
    tax_numbers character varying,
    zip_code character varying,
    town character varying,
    billing_country character varying,
    def boolean,
    billing_address_updated_at timestamp without time zone,
    billing_language character varying,
    billing_currency character varying,
    emails jsonb,
    eknf_id integer,
    partner_id_eknf character varying(50),
    created_at timestamp without time zone,
    updated_at timestamp without time zone
);


--
-- Name: brmtree_test1_sales; Type: TABLE; Schema: dwh; Owner: -
--

CREATE TABLE dwh.brmtree_test1_sales (
    sale_date date,
    partner_id integer,
    service_category text,
    currency character varying(50),
    gross_sales_value_pln numeric,
    net_sales_value_pln numeric,
    net_sales_value_currency numeric,
    gross_fee_value_pln numeric,
    net_fee_value_pln numeric,
    gross_margin_value_pln numeric,
    number_of_products bigint
);


--
-- Name: crmtest1_partner; Type: TABLE; Schema: dwh; Owner: -
--

CREATE TABLE dwh.crmtest1_partner (
    partner_id integer,
    name character varying,
    subdomain character varying,
    domain character varying,
    config_json character varying,
    super_partner boolean,
    max_debit numeric(8,2),
    country character varying,
    default_price_from integer,
    default_price_to integer,
    currency character varying,
    self_registered boolean,
    partner_group character varying,
    is_test_account boolean,
    customer_service_note character varying,
    switched_to_prod_at timestamp without time zone,
    default_services_process_type character varying,
    is_contract_signed boolean,
    custom_contact_email character varying,
    partner_billing_address_id integer,
    company_name character varying,
    address character varying,
    tax_numbers character varying,
    zip_code character varying,
    town character varying,
    billing_country character varying,
    def boolean,
    billing_address_updated_at timestamp without time zone,
    billing_language character varying,
    billing_currency character varying,
    emails jsonb,
    eknf_id integer,
    partner_id_eknf character varying(50),
    created_at timestamp without time zone,
    updated_at timestamp without time zone
);


--
-- Name: crmtest1_sales; Type: TABLE; Schema: dwh; Owner: -
--

CREATE TABLE dwh.crmtest1_sales (
    sale_date date,
    partner_id integer,
    service_category text,
    currency character varying(50),
    gross_sales_value_pln numeric,
    net_sales_value_pln numeric,
    net_sales_value_currency numeric,
    gross_fee_value_pln numeric,
    net_fee_value_pln numeric,
    gross_margin_value_pln numeric,
    number_of_products bigint
);


--
-- Name: crmtree_gold_partner; Type: TABLE; Schema: dwh; Owner: -
--

CREATE TABLE dwh.crmtree_gold_partner (
    partner_id integer,
    name character varying,
    subdomain character varying,
    domain character varying,
    config_json character varying,
    super_partner boolean,
    max_debit numeric(8,2),
    country character varying,
    default_price_from integer,
    default_price_to integer,
    currency character varying,
    self_registered boolean,
    partner_group character varying,
    is_test_account boolean,
    customer_service_note character varying,
    switched_to_prod_at timestamp without time zone,
    default_services_process_type character varying,
    is_contract_signed boolean,
    custom_contact_email character varying,
    partner_billing_address_id integer,
    company_name character varying,
    address character varying,
    tax_numbers character varying,
    zip_code character varying,
    town character varying,
    billing_country character varying,
    def boolean,
    billing_address_updated_at timestamp without time zone,
    billing_language character varying,
    billing_currency character varying,
    emails jsonb,
    eknf_id integer,
    partner_id_eknf character varying(50),
    created_at timestamp without time zone,
    updated_at timestamp without time zone
);


--
-- Name: crmtree_gold_sales; Type: TABLE; Schema: dwh; Owner: -
--

CREATE TABLE dwh.crmtree_gold_sales (
    sale_date date,
    partner_id integer,
    service_category text,
    currency character varying(50),
    gross_sales_value_pln numeric,
    net_sales_value_pln numeric,
    net_sales_value_currency numeric,
    gross_fee_value_pln numeric,
    net_fee_value_pln numeric,
    gross_margin_value_pln numeric,
    number_of_products bigint
);


--
-- Name: _migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._migrations (
    id integer NOT NULL,
    filename character varying(255) NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: _migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public._migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: _migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public._migrations_id_seq OWNED BY public._migrations.id;


--
-- Name: app_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_settings (
    key text NOT NULL,
    value text NOT NULL,
    label text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    value_type text DEFAULT 'number'::text NOT NULL,
    category text DEFAULT 'general'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    tenant_id uuid NOT NULL,
    CONSTRAINT app_settings_value_type_check CHECK ((value_type = ANY (ARRAY['number'::text, 'boolean'::text, 'string'::text, 'json'::text, 'text'::text])))
);


--
-- Name: COLUMN app_settings.tenant_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.app_settings.tenant_id IS 'NULL dozwolony w Sprint 1; PK (tenant_id,key) w Sprint 2.';


--
-- Name: attachment_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachment_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    attachment_id uuid NOT NULL,
    version_number integer DEFAULT 1 NOT NULL,
    label character varying(255),
    blob_path text NOT NULL,
    blob_name text,
    blob_size_bytes bigint,
    mime_type character varying(100),
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    tenant_id uuid NOT NULL
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid,
    user_email character varying(255),
    user_name character varying(200),
    document_id uuid,
    document_number character varying(50),
    document_name character varying(500),
    action public.audit_action NOT NULL,
    before_state jsonb,
    after_state jsonb,
    metadata jsonb,
    ip_address inet,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid NOT NULL
);


--
-- Name: TABLE audit_logs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.audit_logs IS 'Append-only audit trail. App user has INSERT only, no UPDATE/DELETE.';


--
-- Name: crm_api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_api_keys (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    key_hash text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_by uuid,
    last_used timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid NOT NULL
);


--
-- Name: crm_api_keys_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_api_keys_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_api_keys_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_api_keys_id_seq OWNED BY public.crm_api_keys.id;


--
-- Name: crm_email_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_email_attachments (
    id integer NOT NULL,
    lead_id integer,
    gmail_message_id text NOT NULL,
    gmail_attachment_id text,
    filename text NOT NULL,
    mime_type text DEFAULT 'application/octet-stream'::text NOT NULL,
    blob_path text,
    file_size integer,
    direction text DEFAULT 'received'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    partner_id uuid,
    tenant_id uuid NOT NULL
);


--
-- Name: crm_email_attachments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_email_attachments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_email_attachments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_email_attachments_id_seq OWNED BY public.crm_email_attachments.id;


--
-- Name: crm_email_message_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_email_message_reads (
    gmail_message_id character varying(200) NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    gmail_thread_id character varying(200),
    tenant_id uuid NOT NULL
);


--
-- Name: crm_import_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_import_logs (
    id integer NOT NULL,
    import_type character varying(30) NOT NULL,
    filename character varying(300),
    rows_total integer DEFAULT 0 NOT NULL,
    rows_imported integer DEFAULT 0 NOT NULL,
    rows_skipped integer DEFAULT 0 NOT NULL,
    rows_error integer DEFAULT 0 NOT NULL,
    error_details jsonb,
    status character varying(20) DEFAULT 'processing'::character varying NOT NULL,
    imported_by uuid,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    tenant_id uuid NOT NULL
);


--
-- Name: crm_import_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_import_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_import_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_import_logs_id_seq OWNED BY public.crm_import_logs.id;


--
-- Name: crm_lead_activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_lead_activities (
    id integer NOT NULL,
    lead_id integer NOT NULL,
    type character varying(40) NOT NULL,
    title character varying(300) NOT NULL,
    body text,
    activity_at timestamp with time zone,
    duration_min smallint,
    participants text,
    doc_id integer,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    meeting_location text,
    gmail_thread_id text,
    gmail_message_id text,
    status character varying(20) DEFAULT 'new'::character varying NOT NULL,
    close_comment text,
    assigned_to uuid,
    is_read boolean DEFAULT false NOT NULL,
    tenant_id uuid NOT NULL,
    CONSTRAINT crm_lead_activities_status_check CHECK (((status)::text = ANY ((ARRAY['new'::character varying, 'open'::character varying, 'closed'::character varying])::text[])))
);


--
-- Name: crm_lead_activities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_lead_activities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_lead_activities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_lead_activities_id_seq OWNED BY public.crm_lead_activities.id;


--
-- Name: crm_lead_consents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_lead_consents (
    id integer NOT NULL,
    tenant_id uuid NOT NULL,
    lead_id integer NOT NULL,
    consent_key character varying(100) NOT NULL,
    value character varying(20) DEFAULT 'no_data'::character varying NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_lead_consents_value_check CHECK (((value)::text = ANY ((ARRAY['no_data'::character varying, 'granted'::character varying, 'denied'::character varying])::text[])))
);


--
-- Name: crm_lead_consents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_lead_consents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_lead_consents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_lead_consents_id_seq OWNED BY public.crm_lead_consents.id;


--
-- Name: crm_lead_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_lead_contacts (
    id integer NOT NULL,
    lead_id integer NOT NULL,
    contact_name character varying(200),
    contact_title character varying(100),
    email character varying(200),
    phone character varying(50),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    tenant_id uuid NOT NULL
);


--
-- Name: TABLE crm_lead_contacts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.crm_lead_contacts IS 'Dodatkowe kontakty powiązane z leadem. Główny kontakt pozostaje w tabeli crm_leads.';


--
-- Name: crm_lead_contacts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_lead_contacts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_lead_contacts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_lead_contacts_id_seq OWNED BY public.crm_lead_contacts.id;


--
-- Name: crm_lead_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_lead_documents (
    id integer NOT NULL,
    lead_id integer NOT NULL,
    doc_role character varying(80),
    linked_by uuid,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    document_id uuid NOT NULL,
    tenant_id uuid NOT NULL
);


--
-- Name: crm_lead_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_lead_documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_lead_documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_lead_documents_id_seq OWNED BY public.crm_lead_documents.id;


--
-- Name: crm_lead_test_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_lead_test_accounts (
    id integer NOT NULL,
    lead_id integer NOT NULL,
    subdomain character varying(100),
    language character varying(50),
    partner_currency character varying(10),
    country character varying(100),
    billing_address character varying(255),
    billing_zip character varying(20),
    billing_city character varying(100),
    billing_country character varying(100),
    billing_email_address character varying(255),
    admin_first_name character varying(100),
    admin_last_name character varying(100),
    admin_email character varying(255),
    status character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    test_account_number character varying(100),
    last_error text,
    last_called_at timestamp with time zone,
    called_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    htcd_partner_id integer,
    price_list_url character varying(500),
    tenant_id uuid NOT NULL
);


--
-- Name: TABLE crm_lead_test_accounts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.crm_lead_test_accounts IS 'Dane do założenia konta testowego dla Leada. Jeden rekord per lead, aktualizowany przy ponownym wywołaniu.';


--
-- Name: COLUMN crm_lead_test_accounts.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.crm_lead_test_accounts.status IS 'draft=dane zapisane lokalnie, pending=wywołanie w toku, created=konto założone, error=błąd zewnętrznego API';


--
-- Name: COLUMN crm_lead_test_accounts.test_account_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.crm_lead_test_accounts.test_account_number IS 'Numer konta testowego zwrócony przez zewnętrzny system. Przepisywany do crm_partners.partner_number przy migracji.';


--
-- Name: COLUMN crm_lead_test_accounts.htcd_partner_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.crm_lead_test_accounts.htcd_partner_id IS 'ID Partnera nadane przez HTCD po założeniu konta testowego (data.id z odpowiedzi API).';


--
-- Name: COLUMN crm_lead_test_accounts.price_list_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.crm_lead_test_accounts.price_list_url IS 'URL cennika Partnera w HTCD (data.priceListUrl z odpowiedzi API).';


--
-- Name: crm_lead_test_accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_lead_test_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_lead_test_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_lead_test_accounts_id_seq OWNED BY public.crm_lead_test_accounts.id;


--
-- Name: crm_leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_leads (
    id integer NOT NULL,
    company character varying(200) NOT NULL,
    contact_name character varying(150),
    contact_title character varying(100),
    email character varying(200),
    phone character varying(50),
    source character varying(80),
    stage character varying(60) DEFAULT 'new'::character varying NOT NULL,
    value_pln numeric(14,2),
    probability smallint,
    close_date date,
    industry character varying(100),
    assigned_to uuid,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    notes text,
    hot boolean DEFAULT false NOT NULL,
    converted_at timestamp with time zone,
    lost_reason character varying(200),
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    annual_turnover_currency text DEFAULT 'PLN'::text NOT NULL,
    online_pct integer,
    agent_name text,
    agent_email text,
    agent_phone text,
    website text,
    logo_url text,
    nip text,
    first_contact_date date,
    tenant_id uuid NOT NULL,
    CONSTRAINT crm_leads_online_pct_check CHECK (((online_pct IS NULL) OR ((online_pct >= 0) AND (online_pct <= 100) AND ((online_pct % 10) = 0)))),
    CONSTRAINT crm_leads_probability_check CHECK (((probability >= 0) AND (probability <= 100)))
);


--
-- Name: COLUMN crm_leads.nip; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.crm_leads.nip IS 'Numer Identyfikacji Podatkowej — wypełniany ręcznie lub przez enrich';


--
-- Name: COLUMN crm_leads.first_contact_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.crm_leads.first_contact_date IS 'Data pierwszego kontaktu z leadem — ustawiana ręcznie przez handlowca.';


--
-- Name: crm_leads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_leads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_leads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_leads_id_seq OWNED BY public.crm_leads.id;


--
-- Name: crm_onboarding_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_onboarding_tasks (
    id integer NOT NULL,
    step integer NOT NULL,
    title text NOT NULL,
    body text,
    type text DEFAULT 'task'::text NOT NULL,
    assigned_to uuid,
    due_date date,
    done boolean DEFAULT false NOT NULL,
    done_at timestamp with time zone,
    done_by uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    due_time time without time zone,
    partner_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    CONSTRAINT crm_onboarding_tasks_step_check CHECK (((step >= 0) AND (step <= 3))),
    CONSTRAINT crm_onboarding_tasks_type_check CHECK ((type = ANY (ARRAY['task'::text, 'call'::text, 'email'::text, 'meeting'::text, 'note'::text, 'doc_sent'::text, 'training'::text])))
);


--
-- Name: COLUMN crm_onboarding_tasks.due_time; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.crm_onboarding_tasks.due_time IS 'Godzina wykonania zadania. NULL = brak określonej godziny (domyślnie 09:00 w widoku)';


--
-- Name: crm_onboarding_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_onboarding_tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_onboarding_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_onboarding_tasks_id_seq OWNED BY public.crm_onboarding_tasks.id;


--
-- Name: crm_opportunities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_opportunities (
    id integer NOT NULL,
    type character varying(20) NOT NULL,
    title character varying(300) NOT NULL,
    description text,
    value_pln numeric(14,2),
    status character varying(30) DEFAULT 'open'::character varying NOT NULL,
    snooze_until date,
    assigned_to uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    partner_id uuid NOT NULL,
    tenant_id uuid NOT NULL
);


--
-- Name: crm_opportunities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_opportunities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_opportunities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_opportunities_id_seq OWNED BY public.crm_opportunities.id;


--
-- Name: crm_partner_activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_partner_activities (
    id integer NOT NULL,
    type character varying(40) NOT NULL,
    title character varying(300) NOT NULL,
    body text,
    activity_at timestamp with time zone,
    duration_min smallint,
    participants text,
    doc_id integer,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    meeting_location text,
    opp_value numeric(14,2),
    opp_currency character varying(10) DEFAULT 'PLN'::character varying,
    opp_status character varying(20),
    opp_due_date date,
    gmail_thread_id text,
    gmail_message_id text,
    status character varying(20) DEFAULT 'new'::character varying NOT NULL,
    close_comment text,
    assigned_to uuid,
    is_read boolean DEFAULT false NOT NULL,
    partner_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    CONSTRAINT crm_partner_activities_opp_status_check CHECK (((opp_status IS NULL) OR ((opp_status)::text = ANY ((ARRAY['new'::character varying, 'in_progress'::character varying, 'closed'::character varying])::text[])))),
    CONSTRAINT crm_partner_activities_status_check CHECK (((status)::text = ANY ((ARRAY['new'::character varying, 'open'::character varying, 'closed'::character varying])::text[])))
);


--
-- Name: crm_partner_activities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_partner_activities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_partner_activities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_partner_activities_id_seq OWNED BY public.crm_partner_activities.id;


--
-- Name: crm_partner_consents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_partner_consents (
    id integer NOT NULL,
    tenant_id uuid NOT NULL,
    partner_id uuid NOT NULL,
    consent_key character varying(100) NOT NULL,
    value character varying(20) DEFAULT 'no_data'::character varying NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_partner_consents_value_check CHECK (((value)::text = ANY ((ARRAY['no_data'::character varying, 'granted'::character varying, 'denied'::character varying])::text[])))
);


--
-- Name: crm_partner_consents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_partner_consents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_partner_consents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_partner_consents_id_seq OWNED BY public.crm_partner_consents.id;


--
-- Name: crm_partner_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_partner_contacts (
    id integer NOT NULL,
    contact_name character varying(200),
    contact_title character varying(100),
    email character varying(200),
    phone character varying(50),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    partner_id uuid NOT NULL,
    tenant_id uuid NOT NULL
);


--
-- Name: TABLE crm_partner_contacts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.crm_partner_contacts IS 'Dodatkowe kontakty powiązane z partnerem. Główny kontakt pozostaje w tabeli crm_partners.';


--
-- Name: crm_partner_contacts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_partner_contacts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_partner_contacts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_partner_contacts_id_seq OWNED BY public.crm_partner_contacts.id;


--
-- Name: crm_partner_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_partner_documents (
    id integer NOT NULL,
    doc_role character varying(80),
    linked_by uuid,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    partner_id uuid NOT NULL,
    document_id uuid NOT NULL,
    tenant_id uuid NOT NULL
);


--
-- Name: crm_partner_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_partner_documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_partner_documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_partner_documents_id_seq OWNED BY public.crm_partner_documents.id;


--
-- Name: crm_partner_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_partner_groups (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    industry character varying(100),
    description text,
    manager_id uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid NOT NULL
);


--
-- Name: crm_partner_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_partner_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_partner_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_partner_groups_id_seq OWNED BY public.crm_partner_groups.id;


--
-- Name: crm_partner_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_partner_scores (
    tenant_id uuid NOT NULL,
    partner_id uuid NOT NULL,
    churn_score smallint DEFAULT 0 NOT NULL,
    churn_level text DEFAULT 'none'::text NOT NULL,
    days_since_order smallint,
    sales_m1 numeric(14,2),
    sales_m2 numeric(14,2),
    sales_drop_pct numeric(6,1),
    activity_score smallint DEFAULT 0 NOT NULL,
    growth_score smallint DEFAULT 0 NOT NULL,
    health_score smallint DEFAULT 0 NOT NULL,
    health_level text DEFAULT 'risk'::text NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: crm_partners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_partners (
    company character varying(200) NOT NULL,
    nip character varying(20),
    address character varying(300),
    contact_name character varying(150),
    contact_title character varying(100),
    email character varying(200),
    phone character varying(50),
    industry character varying(100),
    group_id integer,
    lead_id integer,
    manager_id uuid,
    contract_doc_id integer,
    contract_signed date,
    contract_expires date,
    contract_value numeric(14,2),
    status character varying(40) DEFAULT 'onboarding'::character varying NOT NULL,
    license_count integer,
    active_users integer,
    onboarding_step smallint DEFAULT 0 NOT NULL,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    billing_contact_name text,
    billing_contact_title text,
    billing_email text,
    billing_phone text,
    credit_limit_value numeric(14,2),
    credit_limit_currency text DEFAULT 'PLN'::text NOT NULL,
    deposit_value numeric(14,2),
    deposit_currency text DEFAULT 'PLN'::text NOT NULL,
    deposit_date_in date,
    deposit_date_out date,
    commission_value numeric(10,4),
    commission_basis text DEFAULT 'nie_dotyczy'::text NOT NULL,
    annual_turnover_currency text DEFAULT 'PLN'::text NOT NULL,
    online_pct integer,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    agent_name text,
    agent_email text,
    agent_phone text,
    logo_url text,
    subdomain character varying(30),
    language character varying(50),
    partner_currency character varying(10),
    country character varying(100),
    billing_address character varying(50),
    billing_zip character varying(10),
    billing_city character varying(30),
    billing_country character varying(100),
    billing_email_address character varying(255),
    admin_first_name character varying(100),
    admin_last_name character varying(100),
    admin_email character varying(255),
    dwh_partner_id integer,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    website text,
    source character varying(80),
    first_contact_date date,
    tenant_id uuid NOT NULL,
    churn_exempt boolean DEFAULT false NOT NULL,
    CONSTRAINT crm_partners_admin_email_check CHECK (((admin_email IS NULL) OR ((admin_email)::text ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'::text))),
    CONSTRAINT crm_partners_billing_email_address_check CHECK (((billing_email_address IS NULL) OR ((billing_email_address)::text ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'::text))),
    CONSTRAINT crm_partners_onboarding_step_check CHECK (((onboarding_step >= 0) AND (onboarding_step <= 3))),
    CONSTRAINT crm_partners_online_pct_check CHECK (((online_pct IS NULL) OR ((online_pct >= 0) AND (online_pct <= 100) AND ((online_pct % 10) = 0)))),
    CONSTRAINT crm_partners_subdomain_check CHECK (((subdomain IS NULL) OR ((subdomain)::text ~ '^[a-z0-9]{3,30}$'::text)))
);


--
-- Name: crm_sales_budgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_sales_budgets (
    id integer NOT NULL,
    user_id uuid NOT NULL,
    year integer NOT NULL,
    period_type text NOT NULL,
    period_number integer NOT NULL,
    amount numeric(14,2) DEFAULT 0 NOT NULL,
    currency text DEFAULT 'PLN'::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    tenant_id uuid NOT NULL,
    CONSTRAINT crm_sales_budgets_period_type_check CHECK ((period_type = ANY (ARRAY['month'::text, 'quarter'::text])))
);


--
-- Name: crm_sales_budgets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_sales_budgets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_sales_budgets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_sales_budgets_id_seq OWNED BY public.crm_sales_budgets.id;


--
-- Name: crm_transaction_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_transaction_products (
    id integer NOT NULL,
    transaction_id integer NOT NULL,
    product_type character varying(40) NOT NULL,
    product_name character varying(300),
    supplier character varying(200),
    booking_ref character varying(100),
    departure_at timestamp with time zone,
    arrival_at timestamp with time zone,
    origin_city character varying(150),
    origin_country character(2),
    destination_city character varying(150),
    destination_country character(2),
    duration_nights smallint,
    hotel_name character varying(200),
    hotel_stars smallint,
    room_type character varying(100),
    check_in date,
    check_out date,
    flight_number character varying(20),
    airline character varying(100),
    cabin_class character varying(30),
    seat character varying(10),
    car_category character varying(80),
    pickup_location character varying(200),
    dropoff_location character varying(200),
    net_cost numeric(14,2) DEFAULT 0 NOT NULL,
    gross_cost numeric(14,2) DEFAULT 0 NOT NULL,
    commission_pct numeric(6,4),
    commission_amt numeric(14,2),
    margin_amt numeric(14,2),
    currency character(3) DEFAULT 'PLN'::bpchar NOT NULL,
    pax_count smallint DEFAULT 1 NOT NULL,
    notes text,
    tenant_id uuid NOT NULL,
    CONSTRAINT crm_transaction_products_hotel_stars_check CHECK (((hotel_stars >= 1) AND (hotel_stars <= 5)))
);


--
-- Name: crm_transaction_products_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_transaction_products_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_transaction_products_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_transaction_products_id_seq OWNED BY public.crm_transaction_products.id;


--
-- Name: crm_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_transactions (
    id integer NOT NULL,
    external_id character varying(100),
    booking_ref character varying(100),
    transaction_date timestamp with time zone NOT NULL,
    traveler_name character varying(200),
    traveler_email character varying(200),
    total_net numeric(14,2) DEFAULT 0 NOT NULL,
    total_gross numeric(14,2) DEFAULT 0 NOT NULL,
    total_commission numeric(14,2) DEFAULT 0 NOT NULL,
    total_margin numeric(14,2) DEFAULT 0 NOT NULL,
    currency character(3) DEFAULT 'PLN'::bpchar NOT NULL,
    status character varying(40) DEFAULT 'confirmed'::character varying NOT NULL,
    raw_payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    partner_id uuid,
    tenant_id uuid NOT NULL
);


--
-- Name: crm_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_transactions_id_seq OWNED BY public.crm_transactions.id;


--
-- Name: doc_number_seq; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doc_number_seq (
    year smallint NOT NULL,
    last_n integer DEFAULT 0 NOT NULL,
    tenant_id uuid NOT NULL
);


--
-- Name: COLUMN doc_number_seq.tenant_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.doc_number_seq.tenant_id IS 'NULL dozwolony w Sprint 1; PK (tenant_id,year) w Sprint 2.';


--
-- Name: document_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    blob_path text,
    blob_name text,
    blob_size_bytes bigint,
    mime_type character varying(100),
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    tenant_id uuid NOT NULL
);


--
-- Name: document_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_groups (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid NOT NULL
);


--
-- Name: document_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_tags (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    document_id uuid NOT NULL,
    key character varying(100) NOT NULL,
    value character varying(500) NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid NOT NULL
);


--
-- Name: document_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_versions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    document_id uuid NOT NULL,
    version_number integer NOT NULL,
    label character varying(300),
    blob_path character varying(1000) NOT NULL,
    blob_name character varying(500),
    blob_size_bytes bigint,
    mime_type character varying(100),
    is_signed boolean DEFAULT false NOT NULL,
    signatory_name character varying(300),
    signatory_email character varying(300),
    signus_signature_id character varying(200),
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid NOT NULL
);


--
-- Name: TABLE document_versions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.document_versions IS 'Immutable archive of every document version (pre-signing, each signatory).';


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    doc_number character varying(50) NOT NULL,
    name character varying(500) NOT NULL,
    doc_type character varying(100) NOT NULL,
    entities text[] DEFAULT '{}'::text[] NOT NULL,
    owner_id uuid,
    group_id uuid,
    document_group_id uuid,
    gdpr_type character varying(100) DEFAULT 'no_gdpr'::public.gdpr_type NOT NULL,
    status public.doc_status DEFAULT 'new'::public.doc_status NOT NULL,
    creation_date date DEFAULT CURRENT_DATE NOT NULL,
    signing_date date,
    expiration_date date,
    blob_path character varying(1000),
    blob_name character varying(500),
    blob_size_bytes bigint,
    mime_type character varying(100),
    signus_envelope_id character varying(200),
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    nip character varying(15),
    country character varying(100),
    contract_subject character varying(100),
    contact_name character varying(200),
    contact_email character varying(255),
    contact_phone character varying(50),
    tenant_id uuid NOT NULL
);


--
-- Name: TABLE documents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.documents IS 'Core documents table. Soft-deleted via deleted_at.';


--
-- Name: COLUMN documents.doc_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.documents.doc_type IS 'Typ dokumentu — wartość z AppSettings (doc_types), np. partner_agreement, Dostawca Content Hotel';


--
-- Name: COLUMN documents.gdpr_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.documents.gdpr_type IS 'Klasyfikacja GDPR — wartość z AppSettings (doc_gdpr_types)';


--
-- Name: COLUMN documents.signus_envelope_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.documents.signus_envelope_id IS 'Tracking ID from Signus e-signing API.';


--
-- Name: COLUMN documents.tenant_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.documents.tenant_id IS 'NULL dozwolony w Sprint 1; NOT NULL enforcement w Sprint 2.';


--
-- Name: group_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_profiles (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(100) NOT NULL,
    display_name character varying(200),
    description text,
    has_owner_restriction boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid NOT NULL
);


--
-- Name: COLUMN group_profiles.has_owner_restriction; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.group_profiles.has_owner_restriction IS 'When true (Sprzedaz), user can only access documents where they are owner.';


--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refresh_tokens (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    token_hash character varying(200) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid NOT NULL
);


--
-- Name: tenant_auth_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_auth_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    provider public.auth_provider_type NOT NULL,
    is_enabled boolean DEFAULT false NOT NULL,
    google_client_id text,
    google_client_secret_ref text,
    google_hd text,
    entra_directory_tenant_id text,
    entra_client_id text,
    entra_client_secret_ref text,
    saml_idp_cert text,
    saml_idp_sso_url text,
    saml_sp_entity_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tenant_email_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_email_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    provider character varying(20) NOT NULL,
    client_id text NOT NULL,
    client_secret text NOT NULL,
    redirect_uri text,
    extra_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_email_providers_provider_check CHECK (((provider)::text = ANY ((ARRAY['gmail'::character varying, 'outlook'::character varying])::text[])))
);


--
-- Name: TABLE tenant_email_providers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.tenant_email_providers IS 'Per-tenant OAuth2 app credentials for email integrations';


--
-- Name: COLUMN tenant_email_providers.client_secret; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tenant_email_providers.client_secret IS 'AES-256-GCM encrypted — use src/utils/encrypt.js to decrypt';


--
-- Name: COLUMN tenant_email_providers.extra_config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tenant_email_providers.extra_config IS 'Provider-specific extras: gmail={pubsub_topic,pubsub_subscription}, outlook={azure_tenant_id}';


--
-- Name: tenant_features; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_features (
    tenant_id uuid NOT NULL,
    feature public.crm_feature_type NOT NULL,
    is_enabled boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE tenant_features; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.tenant_features IS 'Feature-flagi per tenant. Kontrolują widoczność modułów w UI.';


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    slug character varying(64) NOT NULL,
    email_domain character varying(255),
    dwh_schema_prefix character varying(32),
    created_from_tenant_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenants_dwh_schema_prefix_check CHECK (((dwh_schema_prefix IS NULL) OR ((dwh_schema_prefix)::text ~ '^[a-z][a-z0-9_]*$'::text))),
    CONSTRAINT tenants_slug_check CHECK (((slug)::text ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$'::text))
);


--
-- Name: TABLE tenants; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.tenants IS 'Jeden wiersz = jeden klient SaaS (tenant).';


--
-- Name: COLUMN tenants.slug; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tenants.slug IS 'Krótka nazwa używana w URL i jako prefix tabel DWH. Tylko [a-z0-9-].';


--
-- Name: COLUMN tenants.dwh_schema_prefix; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tenants.dwh_schema_prefix IS 'Prefix tabel DWH w schemacie dwh, np. "acme" → dwh.acme_partner.';


--
-- Name: user_email_signatures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_email_signatures (
    user_id uuid NOT NULL,
    html text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid NOT NULL
);


--
-- Name: user_gmail_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_gmail_tokens (
    user_id uuid NOT NULL,
    access_token text NOT NULL,
    refresh_token text,
    token_type text DEFAULT 'Bearer'::text NOT NULL,
    expires_at timestamp with time zone,
    email text,
    history_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid NOT NULL
);


--
-- Name: user_group_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_group_roles (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    group_id uuid NOT NULL,
    access_level public.access_level NOT NULL,
    assigned_by uuid,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid NOT NULL
);


--
-- Name: TABLE user_group_roles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_group_roles IS 'Maps users to group profiles with access level (read/full).';


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    email character varying(255) NOT NULL,
    first_name character varying(100),
    last_name character varying(100),
    display_name character varying(200) GENERATED ALWAYS AS ((((first_name)::text || ' '::text) || (last_name)::text)) STORED,
    is_admin boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    saml_subject character varying(500),
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    crm_role character varying(30),
    is_super_admin boolean DEFAULT false NOT NULL,
    must_change_password boolean DEFAULT false NOT NULL,
    sso_provider public.auth_provider_type,
    sso_subject text,
    password_hash text,
    tenant_id uuid NOT NULL,
    CONSTRAINT users_crm_role_check CHECK ((((crm_role)::text = ANY ((ARRAY['salesperson'::character varying, 'sales_manager'::character varying])::text[])) OR (crm_role IS NULL)))
);


--
-- Name: COLUMN users.is_super_admin; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.is_super_admin IS 'Super admin zarządza tenantami, nie widzi danych biznesowych.';


--
-- Name: COLUMN users.must_change_password; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.must_change_password IS 'Wymagana zmiana hasła przy następnym logowaniu.';


--
-- Name: COLUMN users.sso_subject; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.sso_subject IS 'Google "sub" / Entra "oid" / SAML NameID.';


--
-- Name: COLUMN users.password_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.password_hash IS 'bcrypt hash. NULL dla użytkowników SSO-only.';


--
-- Name: COLUMN users.tenant_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.tenant_id IS 'NULL dozwolony w Sprint 1; NOT NULL enforcement w Sprint 2.';


--
-- Name: workflow_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_tasks (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    document_id uuid NOT NULL,
    assigned_by uuid,
    assigned_to uuid NOT NULL,
    task_type public.workflow_task_type NOT NULL,
    task_status public.workflow_task_status DEFAULT 'pending'::public.workflow_task_status NOT NULL,
    message text,
    due_date date,
    completed_at timestamp with time zone,
    completed_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid NOT NULL
);


--
-- Name: _migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._migrations ALTER COLUMN id SET DEFAULT nextval('public._migrations_id_seq'::regclass);


--
-- Name: crm_api_keys id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_api_keys ALTER COLUMN id SET DEFAULT nextval('public.crm_api_keys_id_seq'::regclass);


--
-- Name: crm_email_attachments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_email_attachments ALTER COLUMN id SET DEFAULT nextval('public.crm_email_attachments_id_seq'::regclass);


--
-- Name: crm_import_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_import_logs ALTER COLUMN id SET DEFAULT nextval('public.crm_import_logs_id_seq'::regclass);


--
-- Name: crm_lead_activities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_activities ALTER COLUMN id SET DEFAULT nextval('public.crm_lead_activities_id_seq'::regclass);


--
-- Name: crm_lead_consents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_consents ALTER COLUMN id SET DEFAULT nextval('public.crm_lead_consents_id_seq'::regclass);


--
-- Name: crm_lead_contacts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_contacts ALTER COLUMN id SET DEFAULT nextval('public.crm_lead_contacts_id_seq'::regclass);


--
-- Name: crm_lead_documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_documents ALTER COLUMN id SET DEFAULT nextval('public.crm_lead_documents_id_seq'::regclass);


--
-- Name: crm_lead_test_accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_test_accounts ALTER COLUMN id SET DEFAULT nextval('public.crm_lead_test_accounts_id_seq'::regclass);


--
-- Name: crm_leads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_leads ALTER COLUMN id SET DEFAULT nextval('public.crm_leads_id_seq'::regclass);


--
-- Name: crm_onboarding_tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_onboarding_tasks ALTER COLUMN id SET DEFAULT nextval('public.crm_onboarding_tasks_id_seq'::regclass);


--
-- Name: crm_opportunities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunities ALTER COLUMN id SET DEFAULT nextval('public.crm_opportunities_id_seq'::regclass);


--
-- Name: crm_partner_activities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_activities ALTER COLUMN id SET DEFAULT nextval('public.crm_partner_activities_id_seq'::regclass);


--
-- Name: crm_partner_consents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_consents ALTER COLUMN id SET DEFAULT nextval('public.crm_partner_consents_id_seq'::regclass);


--
-- Name: crm_partner_contacts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_contacts ALTER COLUMN id SET DEFAULT nextval('public.crm_partner_contacts_id_seq'::regclass);


--
-- Name: crm_partner_documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_documents ALTER COLUMN id SET DEFAULT nextval('public.crm_partner_documents_id_seq'::regclass);


--
-- Name: crm_partner_groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_groups ALTER COLUMN id SET DEFAULT nextval('public.crm_partner_groups_id_seq'::regclass);


--
-- Name: crm_sales_budgets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_budgets ALTER COLUMN id SET DEFAULT nextval('public.crm_sales_budgets_id_seq'::regclass);


--
-- Name: crm_transaction_products id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_transaction_products ALTER COLUMN id SET DEFAULT nextval('public.crm_transaction_products_id_seq'::regclass);


--
-- Name: crm_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_transactions ALTER COLUMN id SET DEFAULT nextval('public.crm_transactions_id_seq'::regclass);


--
-- Name: _migrations _migrations_filename_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._migrations
    ADD CONSTRAINT _migrations_filename_key UNIQUE (filename);


--
-- Name: _migrations _migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._migrations
    ADD CONSTRAINT _migrations_pkey PRIMARY KEY (id);


--
-- Name: app_settings app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (tenant_id, key);


--
-- Name: attachment_versions attachment_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment_versions
    ADD CONSTRAINT attachment_versions_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: crm_api_keys crm_api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_api_keys
    ADD CONSTRAINT crm_api_keys_pkey PRIMARY KEY (id);


--
-- Name: crm_email_attachments crm_email_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_email_attachments
    ADD CONSTRAINT crm_email_attachments_pkey PRIMARY KEY (id);


--
-- Name: crm_email_message_reads crm_email_message_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_email_message_reads
    ADD CONSTRAINT crm_email_message_reads_pkey PRIMARY KEY (gmail_message_id);


--
-- Name: crm_import_logs crm_import_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_import_logs
    ADD CONSTRAINT crm_import_logs_pkey PRIMARY KEY (id);


--
-- Name: crm_lead_activities crm_lead_activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_activities
    ADD CONSTRAINT crm_lead_activities_pkey PRIMARY KEY (id);


--
-- Name: crm_lead_consents crm_lead_consents_lead_id_consent_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_consents
    ADD CONSTRAINT crm_lead_consents_lead_id_consent_key_key UNIQUE (lead_id, consent_key);


--
-- Name: crm_lead_consents crm_lead_consents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_consents
    ADD CONSTRAINT crm_lead_consents_pkey PRIMARY KEY (id);


--
-- Name: crm_lead_contacts crm_lead_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_contacts
    ADD CONSTRAINT crm_lead_contacts_pkey PRIMARY KEY (id);


--
-- Name: crm_lead_documents crm_lead_docs_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_documents
    ADD CONSTRAINT crm_lead_docs_unique UNIQUE (lead_id, document_id);


--
-- Name: crm_lead_documents crm_lead_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_documents
    ADD CONSTRAINT crm_lead_documents_pkey PRIMARY KEY (id);


--
-- Name: crm_lead_test_accounts crm_lead_test_accounts_lead_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_test_accounts
    ADD CONSTRAINT crm_lead_test_accounts_lead_unique UNIQUE (lead_id);


--
-- Name: crm_lead_test_accounts crm_lead_test_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_test_accounts
    ADD CONSTRAINT crm_lead_test_accounts_pkey PRIMARY KEY (id);


--
-- Name: crm_leads crm_leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_leads
    ADD CONSTRAINT crm_leads_pkey PRIMARY KEY (id);


--
-- Name: crm_onboarding_tasks crm_onboarding_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_onboarding_tasks
    ADD CONSTRAINT crm_onboarding_tasks_pkey PRIMARY KEY (id);


--
-- Name: crm_opportunities crm_opportunities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunities
    ADD CONSTRAINT crm_opportunities_pkey PRIMARY KEY (id);


--
-- Name: crm_partner_activities crm_partner_activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_activities
    ADD CONSTRAINT crm_partner_activities_pkey PRIMARY KEY (id);


--
-- Name: crm_partner_consents crm_partner_consents_partner_id_consent_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_consents
    ADD CONSTRAINT crm_partner_consents_partner_id_consent_key_key UNIQUE (partner_id, consent_key);


--
-- Name: crm_partner_consents crm_partner_consents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_consents
    ADD CONSTRAINT crm_partner_consents_pkey PRIMARY KEY (id);


--
-- Name: crm_partner_contacts crm_partner_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_contacts
    ADD CONSTRAINT crm_partner_contacts_pkey PRIMARY KEY (id);


--
-- Name: crm_partner_documents crm_partner_documents_partner_id_document_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_documents
    ADD CONSTRAINT crm_partner_documents_partner_id_document_id_key UNIQUE (partner_id, document_id);


--
-- Name: crm_partner_documents crm_partner_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_documents
    ADD CONSTRAINT crm_partner_documents_pkey PRIMARY KEY (id);


--
-- Name: crm_partner_groups crm_partner_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_groups
    ADD CONSTRAINT crm_partner_groups_pkey PRIMARY KEY (id);


--
-- Name: crm_partner_scores crm_partner_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_scores
    ADD CONSTRAINT crm_partner_scores_pkey PRIMARY KEY (tenant_id, partner_id);


--
-- Name: crm_partners crm_partners_dwh_partner_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partners
    ADD CONSTRAINT crm_partners_dwh_partner_id_key UNIQUE (dwh_partner_id);


--
-- Name: crm_partners crm_partners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partners
    ADD CONSTRAINT crm_partners_pkey PRIMARY KEY (id);


--
-- Name: crm_sales_budgets crm_sales_budgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_budgets
    ADD CONSTRAINT crm_sales_budgets_pkey PRIMARY KEY (id);


--
-- Name: crm_sales_budgets crm_sales_budgets_user_id_year_period_type_period_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_budgets
    ADD CONSTRAINT crm_sales_budgets_user_id_year_period_type_period_number_key UNIQUE (user_id, year, period_type, period_number);


--
-- Name: crm_transaction_products crm_transaction_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_transaction_products
    ADD CONSTRAINT crm_transaction_products_pkey PRIMARY KEY (id);


--
-- Name: crm_transactions crm_transactions_external_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_transactions
    ADD CONSTRAINT crm_transactions_external_id_key UNIQUE (external_id);


--
-- Name: crm_transactions crm_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_transactions
    ADD CONSTRAINT crm_transactions_pkey PRIMARY KEY (id);


--
-- Name: doc_number_seq doc_number_seq_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doc_number_seq
    ADD CONSTRAINT doc_number_seq_pkey PRIMARY KEY (tenant_id, year);


--
-- Name: document_attachments document_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_attachments
    ADD CONSTRAINT document_attachments_pkey PRIMARY KEY (id);


--
-- Name: document_groups document_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_groups
    ADD CONSTRAINT document_groups_pkey PRIMARY KEY (id);


--
-- Name: document_tags document_tags_document_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_tags
    ADD CONSTRAINT document_tags_document_id_key_key UNIQUE (document_id, key);


--
-- Name: document_tags document_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_tags
    ADD CONSTRAINT document_tags_pkey PRIMARY KEY (id);


--
-- Name: document_versions document_versions_document_id_version_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_document_id_version_number_key UNIQUE (document_id, version_number);


--
-- Name: document_versions document_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_pkey PRIMARY KEY (id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: group_profiles group_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_profiles
    ADD CONSTRAINT group_profiles_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: tenant_auth_configs tenant_auth_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_auth_configs
    ADD CONSTRAINT tenant_auth_configs_pkey PRIMARY KEY (id);


--
-- Name: tenant_auth_configs tenant_auth_configs_tenant_id_provider_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_auth_configs
    ADD CONSTRAINT tenant_auth_configs_tenant_id_provider_key UNIQUE (tenant_id, provider);


--
-- Name: tenant_email_providers tenant_email_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_email_providers
    ADD CONSTRAINT tenant_email_providers_pkey PRIMARY KEY (id);


--
-- Name: tenant_email_providers tenant_email_providers_tenant_id_provider_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_email_providers
    ADD CONSTRAINT tenant_email_providers_tenant_id_provider_key UNIQUE (tenant_id, provider);


--
-- Name: tenant_features tenant_features_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_features
    ADD CONSTRAINT tenant_features_pkey PRIMARY KEY (tenant_id, feature);


--
-- Name: tenants tenants_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_name_key UNIQUE (name);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_slug_key UNIQUE (slug);


--
-- Name: user_email_signatures user_email_signatures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_email_signatures
    ADD CONSTRAINT user_email_signatures_pkey PRIMARY KEY (user_id);


--
-- Name: user_gmail_tokens user_gmail_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_gmail_tokens
    ADD CONSTRAINT user_gmail_tokens_pkey PRIMARY KEY (user_id);


--
-- Name: user_group_roles user_group_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_roles
    ADD CONSTRAINT user_group_roles_pkey PRIMARY KEY (id);


--
-- Name: user_group_roles user_group_roles_user_id_group_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_roles
    ADD CONSTRAINT user_group_roles_user_id_group_id_key UNIQUE (user_id, group_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: workflow_tasks workflow_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_tasks
    ADD CONSTRAINT workflow_tasks_pkey PRIMARY KEY (id);


--
-- Name: brmtree_test1_partner_partner_id_idx; Type: INDEX; Schema: dwh; Owner: -
--

CREATE INDEX brmtree_test1_partner_partner_id_idx ON dwh.brmtree_test1_partner USING btree (partner_id);


--
-- Name: brmtree_test1_sales_partner_id_idx; Type: INDEX; Schema: dwh; Owner: -
--

CREATE INDEX brmtree_test1_sales_partner_id_idx ON dwh.brmtree_test1_sales USING btree (partner_id);


--
-- Name: brmtree_test1_sales_partner_id_sale_date_idx; Type: INDEX; Schema: dwh; Owner: -
--

CREATE INDEX brmtree_test1_sales_partner_id_sale_date_idx ON dwh.brmtree_test1_sales USING btree (partner_id, sale_date);


--
-- Name: brmtree_test1_sales_sale_date_idx; Type: INDEX; Schema: dwh; Owner: -
--

CREATE INDEX brmtree_test1_sales_sale_date_idx ON dwh.brmtree_test1_sales USING btree (sale_date);


--
-- Name: crmtest1_partner_partner_id_idx; Type: INDEX; Schema: dwh; Owner: -
--

CREATE INDEX crmtest1_partner_partner_id_idx ON dwh.crmtest1_partner USING btree (partner_id);


--
-- Name: crmtest1_sales_partner_id_idx; Type: INDEX; Schema: dwh; Owner: -
--

CREATE INDEX crmtest1_sales_partner_id_idx ON dwh.crmtest1_sales USING btree (partner_id);


--
-- Name: crmtest1_sales_partner_id_sale_date_idx; Type: INDEX; Schema: dwh; Owner: -
--

CREATE INDEX crmtest1_sales_partner_id_sale_date_idx ON dwh.crmtest1_sales USING btree (partner_id, sale_date);


--
-- Name: crmtest1_sales_sale_date_idx; Type: INDEX; Schema: dwh; Owner: -
--

CREATE INDEX crmtest1_sales_sale_date_idx ON dwh.crmtest1_sales USING btree (sale_date);


--
-- Name: idx_dwh_crmtree_gold_sales_partner_id; Type: INDEX; Schema: dwh; Owner: -
--

CREATE INDEX idx_dwh_crmtree_gold_sales_partner_id ON dwh.crmtree_gold_sales USING btree (partner_id);


--
-- Name: idx_dwh_crmtree_gold_sales_sale_date; Type: INDEX; Schema: dwh; Owner: -
--

CREATE INDEX idx_dwh_crmtree_gold_sales_sale_date ON dwh.crmtree_gold_sales USING btree (sale_date);


--
-- Name: idx_dwh_partner_partner_id; Type: INDEX; Schema: dwh; Owner: -
--

CREATE INDEX idx_dwh_partner_partner_id ON dwh.crmtree_gold_partner USING btree (partner_id);


--
-- Name: idx_dwh_sales_partner_date; Type: INDEX; Schema: dwh; Owner: -
--

CREATE INDEX idx_dwh_sales_partner_date ON dwh.crmtree_gold_sales USING btree (partner_id, sale_date);


--
-- Name: crm_email_message_reads_thread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_email_message_reads_thread_idx ON public.crm_email_message_reads USING btree (gmail_thread_id) WHERE (gmail_thread_id IS NOT NULL);


--
-- Name: crm_import_logs_imported_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_import_logs_imported_by_idx ON public.crm_import_logs USING btree (imported_by);


--
-- Name: crm_import_logs_started_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_import_logs_started_at_idx ON public.crm_import_logs USING btree (started_at DESC);


--
-- Name: idx_att_versions_att; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_att_versions_att ON public.attachment_versions USING btree (attachment_id);


--
-- Name: idx_attachment_versions_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attachment_versions_tenant_id ON public.attachment_versions USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_audit_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_action ON public.audit_logs USING btree (action);


--
-- Name: idx_audit_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_created_at ON public.audit_logs USING btree (created_at DESC);


--
-- Name: idx_audit_doc_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_doc_name_trgm ON public.audit_logs USING gin (document_name public.gin_trgm_ops) WHERE (document_name IS NOT NULL);


--
-- Name: idx_audit_document_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_document_id ON public.audit_logs USING btree (document_id) WHERE (document_id IS NOT NULL);


--
-- Name: idx_audit_logs_tenant_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_tenant_action ON public.audit_logs USING btree (tenant_id, action) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_audit_logs_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_tenant_id ON public.audit_logs USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_audit_logs_tenant_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_tenant_user ON public.audit_logs USING btree (tenant_id, user_id) WHERE ((tenant_id IS NOT NULL) AND (user_id IS NOT NULL));


--
-- Name: idx_audit_user_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_user_email ON public.audit_logs USING btree (user_email) WHERE (user_email IS NOT NULL);


--
-- Name: idx_audit_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_user_id ON public.audit_logs USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_audit_user_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_user_name_trgm ON public.audit_logs USING gin (user_name public.gin_trgm_ops) WHERE (user_name IS NOT NULL);


--
-- Name: idx_cot_partner_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cot_partner_id ON public.crm_onboarding_tasks USING btree (partner_id);


--
-- Name: idx_cot_step; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cot_step ON public.crm_onboarding_tasks USING btree (partner_id, step);


--
-- Name: idx_crm_api_keys_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_api_keys_tenant_id ON public.crm_api_keys USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_email_att_partner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_email_att_partner ON public.crm_email_attachments USING btree (partner_id) WHERE (partner_id IS NOT NULL);


--
-- Name: idx_crm_email_attachments_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_email_attachments_tenant_id ON public.crm_email_attachments USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_email_message_reads_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_email_message_reads_tenant_id ON public.crm_email_message_reads USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_import_logs_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_import_logs_tenant_id ON public.crm_import_logs USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_lead_act_lead; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_lead_act_lead ON public.crm_lead_activities USING btree (lead_id);


--
-- Name: idx_crm_lead_act_tenant_lead; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_lead_act_tenant_lead ON public.crm_lead_activities USING btree (tenant_id, lead_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_lead_activities_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_lead_activities_tenant_id ON public.crm_lead_activities USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_lead_consents_lead; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_lead_consents_lead ON public.crm_lead_consents USING btree (lead_id);


--
-- Name: idx_crm_lead_consents_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_lead_consents_tenant ON public.crm_lead_consents USING btree (tenant_id);


--
-- Name: idx_crm_lead_contacts_lead_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_lead_contacts_lead_id ON public.crm_lead_contacts USING btree (lead_id);


--
-- Name: idx_crm_lead_contacts_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_lead_contacts_tenant_id ON public.crm_lead_contacts USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_lead_documents_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_lead_documents_tenant_id ON public.crm_lead_documents USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_lead_test_accounts_lead_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_lead_test_accounts_lead_id ON public.crm_lead_test_accounts USING btree (lead_id);


--
-- Name: idx_crm_lead_test_accounts_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_lead_test_accounts_tenant_id ON public.crm_lead_test_accounts USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_leads_assigned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_leads_assigned ON public.crm_leads USING btree (assigned_to);


--
-- Name: idx_crm_leads_converted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_leads_converted ON public.crm_leads USING btree (converted_at);


--
-- Name: idx_crm_leads_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_leads_stage ON public.crm_leads USING btree (stage);


--
-- Name: idx_crm_leads_tenant_assigned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_leads_tenant_assigned ON public.crm_leads USING btree (tenant_id, assigned_to) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_leads_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_leads_tenant_id ON public.crm_leads USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_leads_tenant_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_leads_tenant_stage ON public.crm_leads USING btree (tenant_id, stage) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_onboarding_tasks_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_onboarding_tasks_tenant_id ON public.crm_onboarding_tasks USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_opportunities_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_opportunities_tenant_id ON public.crm_opportunities USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_partner_act_partner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_partner_act_partner ON public.crm_partner_activities USING btree (partner_id);


--
-- Name: idx_crm_partner_act_tenant_partner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_partner_act_tenant_partner ON public.crm_partner_activities USING btree (tenant_id, partner_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_partner_activities_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_partner_activities_tenant_id ON public.crm_partner_activities USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_partner_consents_partner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_partner_consents_partner ON public.crm_partner_consents USING btree (partner_id);


--
-- Name: idx_crm_partner_consents_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_partner_consents_tenant ON public.crm_partner_consents USING btree (tenant_id);


--
-- Name: idx_crm_partner_contacts_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_partner_contacts_tenant_id ON public.crm_partner_contacts USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_partner_documents_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_partner_documents_tenant_id ON public.crm_partner_documents USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_partner_groups_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_partner_groups_tenant_id ON public.crm_partner_groups USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_partner_scores_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_partner_scores_tenant ON public.crm_partner_scores USING btree (tenant_id);


--
-- Name: idx_crm_partners_dwh_partner_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_partners_dwh_partner_id ON public.crm_partners USING btree (dwh_partner_id) WHERE (dwh_partner_id IS NOT NULL);


--
-- Name: idx_crm_partners_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_partners_group ON public.crm_partners USING btree (group_id);


--
-- Name: idx_crm_partners_manager; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_partners_manager ON public.crm_partners USING btree (manager_id);


--
-- Name: idx_crm_partners_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_partners_status ON public.crm_partners USING btree (status);


--
-- Name: idx_crm_partners_tenant_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_partners_tenant_group ON public.crm_partners USING btree (tenant_id, group_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_partners_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_partners_tenant_id ON public.crm_partners USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_partners_tenant_manager; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_partners_tenant_manager ON public.crm_partners USING btree (tenant_id, manager_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_partners_tenant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_partners_tenant_status ON public.crm_partners USING btree (tenant_id, status) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_sales_budgets_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_sales_budgets_tenant_id ON public.crm_sales_budgets USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_sales_budgets_tenant_user_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_sales_budgets_tenant_user_year ON public.crm_sales_budgets USING btree (tenant_id, user_id, year) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_transaction_products_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_transaction_products_tenant_id ON public.crm_transaction_products USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_transactions_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_transactions_tenant_id ON public.crm_transactions USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_crm_txn_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_txn_date ON public.crm_transactions USING btree (transaction_date);


--
-- Name: idx_crm_txn_partner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_txn_partner ON public.crm_transactions USING btree (partner_id);


--
-- Name: idx_crm_txn_prod_txn; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_txn_prod_txn ON public.crm_transaction_products USING btree (transaction_id);


--
-- Name: idx_crm_txn_prod_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_txn_prod_type ON public.crm_transaction_products USING btree (product_type);


--
-- Name: idx_doc_attachments_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_attachments_doc ON public.document_attachments USING btree (document_id);


--
-- Name: idx_doc_tags_document_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_tags_document_id ON public.document_tags USING btree (document_id);


--
-- Name: idx_doc_tags_key_value; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_tags_key_value ON public.document_tags USING btree (key, value);


--
-- Name: idx_doc_tags_value_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_tags_value_trgm ON public.document_tags USING gin (value public.gin_trgm_ops);


--
-- Name: idx_doc_versions_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_versions_created_at ON public.document_versions USING btree (created_at DESC);


--
-- Name: idx_doc_versions_document_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_versions_document_id ON public.document_versions USING btree (document_id);


--
-- Name: idx_document_attachments_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_attachments_tenant_id ON public.document_attachments USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_document_groups_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_groups_tenant_id ON public.document_groups USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_document_tags_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_tags_tenant_id ON public.document_tags USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_document_versions_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_versions_tenant_id ON public.document_versions USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_documents_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_created_at ON public.documents USING btree (created_at DESC);


--
-- Name: idx_documents_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_deleted_at ON public.documents USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);


--
-- Name: idx_documents_doc_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_doc_group ON public.documents USING btree (document_group_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_documents_doc_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_doc_number ON public.documents USING btree (doc_number);


--
-- Name: idx_documents_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_expiry ON public.documents USING btree (expiration_date) WHERE (deleted_at IS NULL);


--
-- Name: idx_documents_fts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_fts ON public.documents USING gin (to_tsvector('simple'::regconfig, (((((COALESCE(doc_number, ''::character varying))::text || ' '::text) || (COALESCE(name, ''::character varying))::text) || ' '::text) || COALESCE(public.immutable_array_to_string(entities, ' '::text), ''::text)))) WHERE (deleted_at IS NULL);


--
-- Name: idx_documents_group_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_group_id ON public.documents USING btree (group_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_documents_owner_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_owner_id ON public.documents USING btree (owner_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_documents_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_status ON public.documents USING btree (status) WHERE (deleted_at IS NULL);


--
-- Name: idx_documents_tenant_doc_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_documents_tenant_doc_number ON public.documents USING btree (tenant_id, doc_number) WHERE ((tenant_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: idx_documents_tenant_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_tenant_group ON public.documents USING btree (tenant_id, group_id) WHERE ((tenant_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: idx_documents_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_tenant_id ON public.documents USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_documents_tenant_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_tenant_owner ON public.documents USING btree (tenant_id, owner_id) WHERE ((tenant_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: idx_documents_tenant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_tenant_status ON public.documents USING btree (tenant_id, status) WHERE ((tenant_id IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: idx_email_att_lead; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_att_lead ON public.crm_email_attachments USING btree (lead_id) WHERE (lead_id IS NOT NULL);


--
-- Name: idx_email_att_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_att_message ON public.crm_email_attachments USING btree (gmail_message_id);


--
-- Name: idx_group_profiles_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_group_profiles_name ON public.group_profiles USING btree (name);


--
-- Name: idx_group_profiles_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_group_profiles_tenant_id ON public.group_profiles USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_group_profiles_tenant_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_group_profiles_tenant_name ON public.group_profiles USING btree (tenant_id, name) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_lead_act_activity_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lead_act_activity_at ON public.crm_lead_activities USING btree (activity_at);


--
-- Name: idx_lead_act_assigned_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lead_act_assigned_to ON public.crm_lead_activities USING btree (assigned_to);


--
-- Name: idx_lead_act_gmail_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lead_act_gmail_thread ON public.crm_lead_activities USING btree (gmail_thread_id) WHERE (gmail_thread_id IS NOT NULL);


--
-- Name: idx_lead_act_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lead_act_status ON public.crm_lead_activities USING btree (status);


--
-- Name: idx_part_act_activity_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_part_act_activity_at ON public.crm_partner_activities USING btree (activity_at);


--
-- Name: idx_part_act_assigned_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_part_act_assigned_to ON public.crm_partner_activities USING btree (assigned_to);


--
-- Name: idx_part_act_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_part_act_status ON public.crm_partner_activities USING btree (status);


--
-- Name: idx_partner_act_gmail_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_act_gmail_thread ON public.crm_partner_activities USING btree (gmail_thread_id) WHERE (gmail_thread_id IS NOT NULL);


--
-- Name: idx_refresh_tokens_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_tokens_expires_at ON public.refresh_tokens USING btree (expires_at);


--
-- Name: idx_refresh_tokens_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_tokens_tenant_id ON public.refresh_tokens USING btree (tenant_id);


--
-- Name: idx_refresh_tokens_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_tokens_token_hash ON public.refresh_tokens USING btree (token_hash);


--
-- Name: idx_refresh_tokens_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_tokens_user_id ON public.refresh_tokens USING btree (user_id);


--
-- Name: idx_sales_budgets_user_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_budgets_user_year ON public.crm_sales_budgets USING btree (user_id, year);


--
-- Name: idx_tenant_email_providers_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_email_providers_tenant ON public.tenant_email_providers USING btree (tenant_id);


--
-- Name: idx_tenants_email_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_tenants_email_domain ON public.tenants USING btree (email_domain) WHERE (email_domain IS NOT NULL);


--
-- Name: idx_ugr_group_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ugr_group_id ON public.user_group_roles USING btree (group_id);


--
-- Name: idx_ugr_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ugr_user_id ON public.user_group_roles USING btree (user_id);


--
-- Name: idx_user_email_signatures_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_email_signatures_tenant_id ON public.user_email_signatures USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_user_gmail_tokens_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_gmail_tokens_tenant_id ON public.user_gmail_tokens USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_user_group_roles_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_group_roles_tenant_id ON public.user_group_roles USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_email ON public.users USING btree (email);


--
-- Name: idx_users_saml_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_saml_subject ON public.users USING btree (saml_subject) WHERE (saml_subject IS NOT NULL);


--
-- Name: idx_users_sso_global; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_users_sso_global ON public.users USING btree (sso_provider, sso_subject) WHERE ((sso_provider IS NOT NULL) AND (sso_subject IS NOT NULL));


--
-- Name: idx_users_tenant_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_tenant_active ON public.users USING btree (tenant_id, is_active) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_users_tenant_crm_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_tenant_crm_role ON public.users USING btree (tenant_id, crm_role) WHERE ((tenant_id IS NOT NULL) AND (crm_role IS NOT NULL));


--
-- Name: idx_users_tenant_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_users_tenant_email ON public.users USING btree (tenant_id, email) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_users_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_tenant_id ON public.users USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: idx_wf_tasks_assigned_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wf_tasks_assigned_to ON public.workflow_tasks USING btree (assigned_to);


--
-- Name: idx_wf_tasks_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wf_tasks_created_at ON public.workflow_tasks USING btree (created_at DESC);


--
-- Name: idx_wf_tasks_document_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wf_tasks_document_id ON public.workflow_tasks USING btree (document_id);


--
-- Name: idx_wf_tasks_task_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wf_tasks_task_status ON public.workflow_tasks USING btree (task_status);


--
-- Name: idx_workflow_tasks_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_tasks_tenant_id ON public.workflow_tasks USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);


--
-- Name: document_groups trg_document_groups_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_groups_updated_at BEFORE UPDATE ON public.document_groups FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: document_tags trg_document_tags_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_tags_updated_at BEFORE UPDATE ON public.document_tags FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: documents trg_documents_doc_number; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_documents_doc_number BEFORE INSERT ON public.documents FOR EACH ROW WHEN (((new.doc_number IS NULL) OR ((new.doc_number)::text = ''::text))) EXECUTE FUNCTION public.generate_doc_number();


--
-- Name: documents trg_documents_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_documents_updated_at BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: group_profiles trg_group_profiles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_group_profiles_updated_at BEFORE UPDATE ON public.group_profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: users trg_users_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: workflow_tasks trg_workflow_tasks_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_workflow_tasks_updated_at BEFORE UPDATE ON public.workflow_tasks FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: app_settings app_settings_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: app_settings app_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: attachment_versions attachment_versions_attachment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment_versions
    ADD CONSTRAINT attachment_versions_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES public.document_attachments(id) ON DELETE CASCADE;


--
-- Name: attachment_versions attachment_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment_versions
    ADD CONSTRAINT attachment_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: attachment_versions attachment_versions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment_versions
    ADD CONSTRAINT attachment_versions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: audit_logs audit_logs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: crm_api_keys crm_api_keys_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_api_keys
    ADD CONSTRAINT crm_api_keys_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_api_keys crm_api_keys_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_api_keys
    ADD CONSTRAINT crm_api_keys_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: crm_email_attachments crm_email_attachments_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_email_attachments
    ADD CONSTRAINT crm_email_attachments_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.crm_leads(id) ON DELETE CASCADE;


--
-- Name: crm_email_attachments crm_email_attachments_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_email_attachments
    ADD CONSTRAINT crm_email_attachments_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.crm_partners(id) ON DELETE CASCADE;


--
-- Name: crm_email_attachments crm_email_attachments_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_email_attachments
    ADD CONSTRAINT crm_email_attachments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: crm_email_message_reads crm_email_message_reads_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_email_message_reads
    ADD CONSTRAINT crm_email_message_reads_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: crm_import_logs crm_import_logs_imported_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_import_logs
    ADD CONSTRAINT crm_import_logs_imported_by_fkey FOREIGN KEY (imported_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_import_logs crm_import_logs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_import_logs
    ADD CONSTRAINT crm_import_logs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: crm_lead_activities crm_lead_activities_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_activities
    ADD CONSTRAINT crm_lead_activities_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_lead_activities crm_lead_activities_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_activities
    ADD CONSTRAINT crm_lead_activities_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_lead_activities crm_lead_activities_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_activities
    ADD CONSTRAINT crm_lead_activities_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.crm_leads(id) ON DELETE CASCADE;


--
-- Name: crm_lead_activities crm_lead_activities_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_activities
    ADD CONSTRAINT crm_lead_activities_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: crm_lead_consents crm_lead_consents_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_consents
    ADD CONSTRAINT crm_lead_consents_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.crm_leads(id) ON DELETE CASCADE;


--
-- Name: crm_lead_consents crm_lead_consents_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_consents
    ADD CONSTRAINT crm_lead_consents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: crm_lead_consents crm_lead_consents_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_consents
    ADD CONSTRAINT crm_lead_consents_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_lead_contacts crm_lead_contacts_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_contacts
    ADD CONSTRAINT crm_lead_contacts_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.crm_leads(id) ON DELETE CASCADE;


--
-- Name: crm_lead_contacts crm_lead_contacts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_contacts
    ADD CONSTRAINT crm_lead_contacts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: crm_lead_documents crm_lead_documents_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_documents
    ADD CONSTRAINT crm_lead_documents_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: crm_lead_documents crm_lead_documents_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_documents
    ADD CONSTRAINT crm_lead_documents_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.crm_leads(id) ON DELETE CASCADE;


--
-- Name: crm_lead_documents crm_lead_documents_linked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_documents
    ADD CONSTRAINT crm_lead_documents_linked_by_fkey FOREIGN KEY (linked_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_lead_documents crm_lead_documents_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_documents
    ADD CONSTRAINT crm_lead_documents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: crm_lead_test_accounts crm_lead_test_accounts_called_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_test_accounts
    ADD CONSTRAINT crm_lead_test_accounts_called_by_fkey FOREIGN KEY (called_by) REFERENCES public.users(id);


--
-- Name: crm_lead_test_accounts crm_lead_test_accounts_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_test_accounts
    ADD CONSTRAINT crm_lead_test_accounts_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.crm_leads(id) ON DELETE CASCADE;


--
-- Name: crm_lead_test_accounts crm_lead_test_accounts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_test_accounts
    ADD CONSTRAINT crm_lead_test_accounts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: crm_leads crm_leads_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_leads
    ADD CONSTRAINT crm_leads_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_leads crm_leads_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_leads
    ADD CONSTRAINT crm_leads_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_leads crm_leads_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_leads
    ADD CONSTRAINT crm_leads_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: crm_onboarding_tasks crm_onboarding_tasks_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_onboarding_tasks
    ADD CONSTRAINT crm_onboarding_tasks_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_onboarding_tasks crm_onboarding_tasks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_onboarding_tasks
    ADD CONSTRAINT crm_onboarding_tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_onboarding_tasks crm_onboarding_tasks_done_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_onboarding_tasks
    ADD CONSTRAINT crm_onboarding_tasks_done_by_fkey FOREIGN KEY (done_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_onboarding_tasks crm_onboarding_tasks_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_onboarding_tasks
    ADD CONSTRAINT crm_onboarding_tasks_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.crm_partners(id) ON DELETE CASCADE;


--
-- Name: crm_onboarding_tasks crm_onboarding_tasks_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_onboarding_tasks
    ADD CONSTRAINT crm_onboarding_tasks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: crm_opportunities crm_opportunities_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunities
    ADD CONSTRAINT crm_opportunities_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_opportunities crm_opportunities_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunities
    ADD CONSTRAINT crm_opportunities_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_opportunities crm_opportunities_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunities
    ADD CONSTRAINT crm_opportunities_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.crm_partners(id) ON DELETE CASCADE;


--
-- Name: crm_opportunities crm_opportunities_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunities
    ADD CONSTRAINT crm_opportunities_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: crm_partner_activities crm_partner_activities_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_activities
    ADD CONSTRAINT crm_partner_activities_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_partner_activities crm_partner_activities_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_activities
    ADD CONSTRAINT crm_partner_activities_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_partner_activities crm_partner_activities_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_activities
    ADD CONSTRAINT crm_partner_activities_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.crm_partners(id) ON DELETE CASCADE;


--
-- Name: crm_partner_activities crm_partner_activities_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_activities
    ADD CONSTRAINT crm_partner_activities_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: crm_partner_consents crm_partner_consents_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_consents
    ADD CONSTRAINT crm_partner_consents_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.crm_partners(id) ON DELETE CASCADE;


--
-- Name: crm_partner_consents crm_partner_consents_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_consents
    ADD CONSTRAINT crm_partner_consents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: crm_partner_consents crm_partner_consents_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_consents
    ADD CONSTRAINT crm_partner_consents_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_partner_contacts crm_partner_contacts_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_contacts
    ADD CONSTRAINT crm_partner_contacts_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.crm_partners(id) ON DELETE CASCADE;


--
-- Name: crm_partner_contacts crm_partner_contacts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_contacts
    ADD CONSTRAINT crm_partner_contacts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: crm_partner_documents crm_partner_documents_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_documents
    ADD CONSTRAINT crm_partner_documents_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: crm_partner_documents crm_partner_documents_linked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_documents
    ADD CONSTRAINT crm_partner_documents_linked_by_fkey FOREIGN KEY (linked_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_partner_documents crm_partner_documents_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_documents
    ADD CONSTRAINT crm_partner_documents_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.crm_partners(id) ON DELETE CASCADE;


--
-- Name: crm_partner_documents crm_partner_documents_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_documents
    ADD CONSTRAINT crm_partner_documents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: crm_partner_groups crm_partner_groups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_groups
    ADD CONSTRAINT crm_partner_groups_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_partner_groups crm_partner_groups_manager_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_groups
    ADD CONSTRAINT crm_partner_groups_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_partner_groups crm_partner_groups_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_groups
    ADD CONSTRAINT crm_partner_groups_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: crm_partner_scores crm_partner_scores_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_scores
    ADD CONSTRAINT crm_partner_scores_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.crm_partners(id) ON DELETE CASCADE;


--
-- Name: crm_partner_scores crm_partner_scores_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partner_scores
    ADD CONSTRAINT crm_partner_scores_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: crm_partners crm_partners_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partners
    ADD CONSTRAINT crm_partners_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_partners crm_partners_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partners
    ADD CONSTRAINT crm_partners_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.crm_partner_groups(id) ON DELETE SET NULL;


--
-- Name: crm_partners crm_partners_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partners
    ADD CONSTRAINT crm_partners_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.crm_leads(id) ON DELETE SET NULL;


--
-- Name: crm_partners crm_partners_manager_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partners
    ADD CONSTRAINT crm_partners_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crm_partners crm_partners_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_partners
    ADD CONSTRAINT crm_partners_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: crm_sales_budgets crm_sales_budgets_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_budgets
    ADD CONSTRAINT crm_sales_budgets_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: crm_sales_budgets crm_sales_budgets_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_budgets
    ADD CONSTRAINT crm_sales_budgets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: crm_sales_budgets crm_sales_budgets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_budgets
    ADD CONSTRAINT crm_sales_budgets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: crm_transaction_products crm_transaction_products_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_transaction_products
    ADD CONSTRAINT crm_transaction_products_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: crm_transaction_products crm_transaction_products_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_transaction_products
    ADD CONSTRAINT crm_transaction_products_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.crm_transactions(id) ON DELETE CASCADE;


--
-- Name: crm_transactions crm_transactions_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_transactions
    ADD CONSTRAINT crm_transactions_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.crm_partners(id) ON DELETE SET NULL;


--
-- Name: crm_transactions crm_transactions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_transactions
    ADD CONSTRAINT crm_transactions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: doc_number_seq doc_number_seq_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doc_number_seq
    ADD CONSTRAINT doc_number_seq_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: document_attachments document_attachments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_attachments
    ADD CONSTRAINT document_attachments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: document_attachments document_attachments_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_attachments
    ADD CONSTRAINT document_attachments_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_attachments document_attachments_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_attachments
    ADD CONSTRAINT document_attachments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: document_groups document_groups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_groups
    ADD CONSTRAINT document_groups_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_groups document_groups_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_groups
    ADD CONSTRAINT document_groups_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: document_tags document_tags_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_tags
    ADD CONSTRAINT document_tags_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_tags document_tags_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_tags
    ADD CONSTRAINT document_tags_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_tags document_tags_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_tags
    ADD CONSTRAINT document_tags_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: document_versions document_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_versions document_versions_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_versions document_versions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: documents documents_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: documents documents_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: documents documents_document_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_document_group_id_fkey FOREIGN KEY (document_group_id) REFERENCES public.document_groups(id) ON DELETE SET NULL;


--
-- Name: documents documents_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.group_profiles(id) ON DELETE RESTRICT;


--
-- Name: documents documents_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: documents documents_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: group_profiles group_profiles_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_profiles
    ADD CONSTRAINT group_profiles_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: group_profiles group_profiles_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_profiles
    ADD CONSTRAINT group_profiles_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: refresh_tokens refresh_tokens_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tenant_auth_configs tenant_auth_configs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_auth_configs
    ADD CONSTRAINT tenant_auth_configs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tenant_email_providers tenant_email_providers_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_email_providers
    ADD CONSTRAINT tenant_email_providers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tenant_features tenant_features_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_features
    ADD CONSTRAINT tenant_features_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tenants tenants_created_from_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_created_from_tenant_id_fkey FOREIGN KEY (created_from_tenant_id) REFERENCES public.tenants(id) ON DELETE SET NULL;


--
-- Name: user_email_signatures user_email_signatures_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_email_signatures
    ADD CONSTRAINT user_email_signatures_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: user_email_signatures user_email_signatures_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_email_signatures
    ADD CONSTRAINT user_email_signatures_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_gmail_tokens user_gmail_tokens_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_gmail_tokens
    ADD CONSTRAINT user_gmail_tokens_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: user_gmail_tokens user_gmail_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_gmail_tokens
    ADD CONSTRAINT user_gmail_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_group_roles user_group_roles_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_roles
    ADD CONSTRAINT user_group_roles_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: user_group_roles user_group_roles_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_roles
    ADD CONSTRAINT user_group_roles_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.group_profiles(id) ON DELETE CASCADE;


--
-- Name: user_group_roles user_group_roles_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_roles
    ADD CONSTRAINT user_group_roles_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: user_group_roles user_group_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_roles
    ADD CONSTRAINT user_group_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- Name: workflow_tasks workflow_tasks_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_tasks
    ADD CONSTRAINT workflow_tasks_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workflow_tasks workflow_tasks_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_tasks
    ADD CONSTRAINT workflow_tasks_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workflow_tasks workflow_tasks_completed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_tasks
    ADD CONSTRAINT workflow_tasks_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workflow_tasks workflow_tasks_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_tasks
    ADD CONSTRAINT workflow_tasks_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: workflow_tasks workflow_tasks_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_tasks
    ADD CONSTRAINT workflow_tasks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--

\unrestrict vgWq8arN7N83w0kEKiLpABlUYqvXffS8oPgwwgQoNrsnLLiAakk4XFmZgoWqcUD

