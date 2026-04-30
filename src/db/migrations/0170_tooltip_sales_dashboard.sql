-- 0170_tooltip_sales_dashboard.sql
-- Seed tooltip texts for CRM Sales Dashboard screen.
-- ON CONFLICT DO NOTHING — does not overwrite manually edited texts.

INSERT INTO app_settings (key, value, label, description, value_type, category) VALUES

-- ─── Sales Dashboard – KPI ───────────────────────────────────────────────────

('crm.sales.kpi.new_contacts',
 'Liczba leadów w etapie Nowy — czyli świeżo dodanych kontaktów, które nie zostały jeszcze zakwalifikowane. Kliknij kafelek, aby zobaczyć tę listę. Trend pokazuje zmianę względem poprzedniego tygodnia.',
 'Sales Dashboard – KPI: Nowe kontakty',
 '', 'string', 'tooltip'),

('crm.sales.kpi.new_companies',
 'Liczba unikalnych firm, które pojawiły się w Twoim pipeline w bieżącym tygodniu (etap Nowy). Jeden lead = jedna firma. Kliknij, aby zobaczyć listę leadów na etapie Nowy.',
 'Sales Dashboard – KPI: Nowe firmy',
 '', 'string', 'tooltip'),

('crm.sales.kpi.new_leads',
 'Łączna liczba aktywnych szans sprzedażowych w Twoim pipeline — leady, które nie zostały jeszcze zamknięte (ani wygrane, ani przegrane). Kliknij, aby zobaczyć pełną listę aktywnego pipeline.',
 'Sales Dashboard – KPI: Nowe szanse (aktywny pipeline)',
 '', 'string', 'tooltip'),

('crm.sales.kpi.pipeline_value',
 'Łączna szacowana wartość wszystkich aktywnych szans w pipeline. Obliczana jako suma wartości ważonych prawdopodobieństwem (value × probability %) dla etapów: Nowy, Kwalifikacja, Oferta, Negocjacje i Onboarding. Kliknij, aby zobaczyć listę.',
 'Sales Dashboard – KPI: Wartość szans (pipeline)',
 '', 'string', 'tooltip'),

('crm.sales.kpi.won',
 'Liczba szans zamkniętych jako Wygrane (Closed Won) w bieżącym miesiącu. Kliknij, aby przejść do listy wygranych kontraktów.',
 'Sales Dashboard – KPI: Wygrane szanse',
 '', 'string', 'tooltip'),

-- ─── Sales Dashboard – Panele ────────────────────────────────────────────────

('crm.sales.pipeline',
 'Rozkład szans sprzedażowych po etapach pipeline. Przełącznik Wartość / Ilość zmienia metrykę wyświetlaną na pasku. Kliknij wiersz, aby przejść do listy leadów na danym etapie.',
 'Sales Dashboard – Panel: Pipeline sprzedaży',
 '', 'string', 'tooltip'),

('crm.sales.chart',
 'Skumulowana wartość nowo dodanych leadów w wybranym okresie (Tydzień / Miesiąc / Kwartał). Wykres pokazuje trend — czy wartość portfolio rośnie. Procent zmiana porównana jest z poprzednim równoważnym okresem.',
 'Sales Dashboard – Panel: Wyniki sprzedażowe (wykres)',
 '', 'string', 'tooltip'),

('crm.sales.tasks',
 'Lista zadań zaplanowanych na dziś — ze wszystkich leadów i partnerów przypisanych do Ciebie. Zaznacz checkbox, aby oznaczyć zadanie jako wykonane. Kliknij treść zadania, aby przejść do powiązanego leada lub partnera.',
 'Sales Dashboard – Panel: Zadania na dziś',
 '', 'string', 'tooltip'),

('crm.sales.recent_leads',
 'Ostatnio dodane szanse sprzedażowe z Twojego pipeline. Kliknij wiersz, aby otworzyć szczegóły leada. Kliknij „Zobacz wszystkie szanse", aby przejść do pełnej listy.',
 'Sales Dashboard – Panel: Najnowsze szanse (tabela)',
 '', 'string', 'tooltip'),

('crm.sales.activity',
 'Chronologiczny feed ostatnich aktywności — telefony, e-maile, spotkania, notatki — powiązanych z Twoimi leadami i partnerami. Kliknij wpis, aby przejść do powiązanego rekordu.',
 'Sales Dashboard – Panel: Ostatnia aktywność',
 '', 'string', 'tooltip')

ON CONFLICT (key) DO NOTHING;
