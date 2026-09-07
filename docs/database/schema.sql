--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11 (32e7196)
-- Dumped by pg_dump version 18.6 (Homebrew)

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
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: sync_default_environment(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_default_environment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO public.environments (id, site_id, name, domain, enabled, allow_localhost, created_at)
  VALUES (NEW.id, NEW.id, 'Production', NEW.domain, NEW.enabled, NEW.allow_localhost, NEW.created_at)
  ON CONFLICT (id) DO UPDATE SET
    domain = EXCLUDED.domain, enabled = EXCLUDED.enabled, allow_localhost = EXCLUDED.allow_localhost;
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: abuse_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.abuse_daily (
    environment_id uuid NOT NULL,
    day date NOT NULL,
    reason text NOT NULL,
    blocked bigint DEFAULT 0 NOT NULL,
    last_blocked_at timestamp with time zone NOT NULL
);


--
-- Name: abuse_environment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.abuse_environment (
    environment_id uuid NOT NULL,
    baseline jsonb NOT NULL,
    learned_at timestamp with time zone NOT NULL,
    traffic jsonb NOT NULL
);


--
-- Name: abuse_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.abuse_sources (
    environment_id uuid NOT NULL,
    source text NOT NULL,
    activity jsonb NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account (
    id text NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp without time zone,
    refresh_token_expires_at timestamp without time zone,
    scope text,
    password text,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL
);


--
-- Name: activity_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activity_events (
    environment_id uuid NOT NULL,
    id uuid NOT NULL,
    session_key text NOT NULL,
    visitor_key text NOT NULL,
    received_at timestamp with time zone NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    path text NOT NULL,
    referrer text NOT NULL,
    country text NOT NULL,
    device text NOT NULL,
    browser text NOT NULL,
    os text NOT NULL,
    details jsonb NOT NULL
);


--
-- Name: billing_checkouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_checkouts (
    owner_id text NOT NULL,
    checkout_id text NOT NULL
);


--
-- Name: billing_customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_customers (
    customer_id text NOT NULL,
    owner_id text,
    subscriptions jsonb NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: billing_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id text NOT NULL,
    event_type text NOT NULL,
    event_count numeric(20,2) NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    attempts bigint DEFAULT 0 NOT NULL,
    lease_id uuid,
    CONSTRAINT billing_outbox_count_check CHECK ((event_count > (0)::numeric))
);


--
-- Name: billing_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_usage (
    owner_id text NOT NULL,
    site_id uuid NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    events numeric(20,2) DEFAULT 0 NOT NULL
);


--
-- Name: billing_webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_webhook_events (
    id text NOT NULL,
    type text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: daily_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_stats (
    site_id uuid NOT NULL,
    day date NOT NULL,
    dimension text NOT NULL,
    value text NOT NULL,
    pageviews bigint DEFAULT 0 NOT NULL,
    custom_events bigint DEFAULT 0 NOT NULL,
    visitors bigint DEFAULT 0 NOT NULL
);


--
-- Name: daily_visitors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_visitors (
    site_id uuid NOT NULL,
    day date NOT NULL,
    visitor text NOT NULL
);


--
-- Name: environments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.environments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    site_id uuid NOT NULL,
    name text NOT NULL,
    domain text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    allow_localhost boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tracking_mode text DEFAULT 'cookieless'::text NOT NULL,
    tracking_settings jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    site_id uuid NOT NULL,
    id uuid NOT NULL,
    received_at timestamp with time zone NOT NULL,
    day date NOT NULL,
    type text NOT NULL,
    name text NOT NULL,
    path text NOT NULL,
    referrer text NOT NULL,
    country text NOT NULL,
    device text NOT NULL,
    visitor text NOT NULL,
    CONSTRAINT events_type_check CHECK ((type = ANY (ARRAY['pageview'::text, 'event'::text])))
);


--
-- Name: free_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.free_usage (
    owner_id text NOT NULL,
    site_id uuid NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    events numeric(20,2) DEFAULT 0 NOT NULL
);


--
-- Name: rate_limit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limit (
    id text NOT NULL,
    key text NOT NULL,
    count integer NOT NULL,
    last_request bigint NOT NULL
);


--
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    id text NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    token text NOT NULL,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL,
    ip_address text,
    user_agent text,
    user_id text NOT NULL
);


--
-- Name: sites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id text NOT NULL,
    name text NOT NULL,
    domain text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    allow_localhost boolean DEFAULT false NOT NULL,
    credit_budget numeric(20,2)
);


--
-- Name: user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."user" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL
);


--
-- Name: verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL
);


--
-- Name: abuse_daily abuse_daily_environment_id_day_reason_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.abuse_daily
    ADD CONSTRAINT abuse_daily_environment_id_day_reason_pk PRIMARY KEY (environment_id, day, reason);


--
-- Name: abuse_environment abuse_environment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.abuse_environment
    ADD CONSTRAINT abuse_environment_pkey PRIMARY KEY (environment_id);


--
-- Name: abuse_sources abuse_sources_environment_id_source_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.abuse_sources
    ADD CONSTRAINT abuse_sources_environment_id_source_pk PRIMARY KEY (environment_id, source);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: activity_events activity_events_environment_id_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_events
    ADD CONSTRAINT activity_events_environment_id_id_pk PRIMARY KEY (environment_id, id);


--
-- Name: billing_checkouts billing_checkouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_checkouts
    ADD CONSTRAINT billing_checkouts_pkey PRIMARY KEY (owner_id);


--
-- Name: billing_customers billing_customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_customers
    ADD CONSTRAINT billing_customers_pkey PRIMARY KEY (customer_id);


--
-- Name: billing_outbox billing_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_outbox
    ADD CONSTRAINT billing_outbox_pkey PRIMARY KEY (id);


--
-- Name: billing_usage billing_usage_owner_id_period_start_site_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_usage
    ADD CONSTRAINT billing_usage_owner_id_period_start_site_id_pk PRIMARY KEY (owner_id, period_start, site_id);


--
-- Name: billing_webhook_events billing_webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_webhook_events
    ADD CONSTRAINT billing_webhook_events_pkey PRIMARY KEY (id);


--
-- Name: daily_stats daily_stats_site_id_day_dimension_value_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_stats
    ADD CONSTRAINT daily_stats_site_id_day_dimension_value_pk PRIMARY KEY (site_id, day, dimension, value);


--
-- Name: daily_visitors daily_visitors_site_id_day_visitor_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_visitors
    ADD CONSTRAINT daily_visitors_site_id_day_visitor_pk PRIMARY KEY (site_id, day, visitor);


--
-- Name: environments environments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_pkey PRIMARY KEY (id);


--
-- Name: events events_site_id_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_site_id_id_pk PRIMARY KEY (site_id, id);


--
-- Name: free_usage free_usage_owner_id_period_start_site_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.free_usage
    ADD CONSTRAINT free_usage_owner_id_period_start_site_id_pk PRIMARY KEY (owner_id, period_start, site_id);


--
-- Name: rate_limit rate_limit_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit
    ADD CONSTRAINT rate_limit_key_unique UNIQUE (key);


--
-- Name: rate_limit rate_limit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit
    ADD CONSTRAINT rate_limit_pkey PRIMARY KEY (id);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_token_unique UNIQUE (token);


--
-- Name: sites sites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_pkey PRIMARY KEY (id);


--
-- Name: user user_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_email_unique UNIQUE (email);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: abuse_daily_retention_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX abuse_daily_retention_idx ON public.abuse_daily USING btree (day);


--
-- Name: abuse_sources_retention_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX abuse_sources_retention_idx ON public.abuse_sources USING btree (updated_at);


--
-- Name: account_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "account_userId_idx" ON public.account USING btree (user_id);


--
-- Name: activity_environment_received_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activity_environment_received_idx ON public.activity_events USING btree (environment_id, received_at);


--
-- Name: activity_retention_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activity_retention_idx ON public.activity_events USING btree (received_at);


--
-- Name: activity_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activity_session_idx ON public.activity_events USING btree (environment_id, session_key, received_at);


--
-- Name: billing_customers_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX billing_customers_owner_idx ON public.billing_customers USING btree (owner_id);


--
-- Name: billing_outbox_available_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX billing_outbox_available_idx ON public.billing_outbox USING btree (available_at);


--
-- Name: environments_site_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX environments_site_name_idx ON public.environments USING btree (site_id, lower(name));


--
-- Name: events_retention_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_retention_idx ON public.events USING btree (received_at);


--
-- Name: events_site_received_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_site_received_idx ON public.events USING btree (site_id, received_at);


--
-- Name: session_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "session_userId_idx" ON public.session USING btree (user_id);


--
-- Name: sites_owner_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sites_owner_domain_idx ON public.sites USING btree (owner_id, domain);


--
-- Name: sites_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sites_owner_idx ON public.sites USING btree (owner_id);


--
-- Name: stats_retention_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stats_retention_idx ON public.daily_stats USING btree (day);


--
-- Name: verification_identifier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verification_identifier_idx ON public.verification USING btree (identifier);


--
-- Name: visitors_retention_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX visitors_retention_idx ON public.daily_visitors USING btree (day);


--
-- Name: sites sites_default_environment; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sites_default_environment AFTER INSERT OR UPDATE OF domain, enabled, allow_localhost ON public.sites FOR EACH ROW EXECUTE FUNCTION public.sync_default_environment();


--
-- Name: abuse_daily abuse_daily_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.abuse_daily
    ADD CONSTRAINT abuse_daily_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: abuse_environment abuse_environment_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.abuse_environment
    ADD CONSTRAINT abuse_environment_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: abuse_sources abuse_sources_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.abuse_sources
    ADD CONSTRAINT abuse_sources_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: account account_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: activity_events activity_events_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_events
    ADD CONSTRAINT activity_events_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: billing_checkouts billing_checkouts_owner_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_checkouts
    ADD CONSTRAINT billing_checkouts_owner_id_user_id_fk FOREIGN KEY (owner_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: billing_customers billing_customers_owner_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_customers
    ADD CONSTRAINT billing_customers_owner_id_user_id_fk FOREIGN KEY (owner_id) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: billing_outbox billing_outbox_owner_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_outbox
    ADD CONSTRAINT billing_outbox_owner_id_user_id_fk FOREIGN KEY (owner_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: billing_usage billing_usage_owner_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_usage
    ADD CONSTRAINT billing_usage_owner_id_user_id_fk FOREIGN KEY (owner_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: daily_stats daily_stats_site_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_stats
    ADD CONSTRAINT daily_stats_site_id_environments_id_fk FOREIGN KEY (site_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: daily_visitors daily_visitors_site_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_visitors
    ADD CONSTRAINT daily_visitors_site_id_environments_id_fk FOREIGN KEY (site_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: environments environments_site_id_sites_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_site_id_sites_id_fk FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: events events_site_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_site_id_environments_id_fk FOREIGN KEY (site_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: free_usage free_usage_owner_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.free_usage
    ADD CONSTRAINT free_usage_owner_id_user_id_fk FOREIGN KEY (owner_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: session session_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: sites sites_owner_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_owner_id_user_id_fk FOREIGN KEY (owner_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--
