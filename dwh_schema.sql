--
-- PostgreSQL database dump
--

\restrict XtkkkAbComnJ8v52mLzBsdtOjpzwVbxy5PCLbkGcihCiOssTrJLLRzwV8Q1DMak

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
-- PostgreSQL database dump complete
--

\unrestrict XtkkkAbComnJ8v52mLzBsdtOjpzwVbxy5PCLbkGcihCiOssTrJLLRzwV8Q1DMak

