-- 0199_seo_content_pieces.sql
-- Faza 0 (SEObot): public blog content storage + internal CRMtree tenant for dogfooding.

INSERT INTO tenants (id, name, slug, is_active)
VALUES ('4a299a1b-9e33-43d7-b649-ead5a17d61fc', 'CRMtree', 'crmtree', true)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS seo_content_pieces (
  id                SERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  locale            VARCHAR(5) NOT NULL DEFAULT 'pl',
  title             VARCHAR(255) NOT NULL,
  slug              VARCHAR(255) NOT NULL,
  body              TEXT NOT NULL,
  meta_description  VARCHAR(320),
  status            VARCHAR(20) NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'in_review', 'approved', 'scheduled', 'published', 'needs_update', 'archived')),
  target_keyword    VARCHAR(255),
  category          VARCHAR(100),
  header_image_url  TEXT,
  scheduled_at      TIMESTAMPTZ,
  published_at      TIMESTAMPTZ,
  reviewed_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, locale, slug)
);

CREATE INDEX IF NOT EXISTS idx_seo_content_tenant_status    ON seo_content_pieces (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_seo_content_published_lookup ON seo_content_pieces (tenant_id, locale, published_at) WHERE status = 'published';

CREATE TRIGGER trg_seo_content_pieces_updated_at
  BEFORE UPDATE ON seo_content_pieces
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed: two published sample articles for the CRMtree tenant itself (dogfooding),
-- so the public blog has real content to render while Faza 1's generation pipeline doesn't exist yet.
INSERT INTO seo_content_pieces
  (tenant_id, locale, title, slug, body, meta_description, status, category, published_at)
VALUES
  (
    '4a299a1b-9e33-43d7-b649-ead5a17d61fc', 'pl',
    'Jak zarządzać lejkiem sprzedażowym, żeby nie tracić leadów',
    'jak-zarzadzac-lejkiem-sprzedazowym',
    E'Zarządzanie lejkiem sprzedażowym to codzienna praca handlowca, nie jednorazowy projekt. W tym artykule pokazujemy, jak CRM pomaga uporządkować etapy lejka, przypisywać leady do właściwych osób i nie tracić szans sprzedażowych przez brak follow-upu.\n\nKażdy etap lejka — od pierwszego kontaktu, przez kwalifikację, aż po zamknięcie — wymaga innego rodzaju uwagi. Dobrze skonfigurowany CRM pozwala zespołowi sprzedaży widzieć, gdzie utknęła dana szansa, i reagować zanim lead ostygnie.',
    'Jak skutecznie zarządzać lejkiem sprzedażowym w CRM — etapy, przypisywanie leadów i unikanie utraty szans sprzedażowych.',
    'published', 'sprzedaz', now()
  ),
  (
    '4a299a1b-9e33-43d7-b649-ead5a17d61fc', 'pl',
    'Upsell i cross-sell: jak systematycznie zwiększać wartość klienta',
    'upsell-cross-sell-w-crm',
    E'Upsell i cross-sell to nie przypadkowe okazje, tylko proces, który da się zaplanować i śledzić w CRM. W artykule opisujemy, jak oznaczać okazje do dosprzedaży, kiedy najlepiej je proponować i jak mierzyć skuteczność takich działań w czasie.\n\nKluczem jest widoczność: handlowiec, który widzi pełną historię klienta w jednym miejscu, łatwiej rozpoznaje moment, w którym warto zaproponować rozszerzenie usługi lub produkt komplementarny.',
    'Jak systematycznie budować upsell i cross-sell w CRM — planowanie, śledzenie okazji i mierzenie skuteczności.',
    'published', 'sprzedaz', now()
  )
ON CONFLICT (tenant_id, locale, slug) DO NOTHING;
