-- 0169_tooltip_seed_data.sql
-- Seed initial tooltip texts for Partner Performance and Raporty sprzedaży screens.
-- All entries are editable/deletable via Admin > Ustawienia > Podpowiedzi.
-- ON CONFLICT DO NOTHING — does not overwrite manually edited texts.

INSERT INTO app_settings (key, value, label, description, value_type, category) VALUES

-- ─── Partner Performance ─────────────────────────────────────────────────────

('crm.partners.kpi.gross_turnover',
 'Łączna wartość sprzedaży brutto wygenerowana przez wszystkich aktywnych partnerów w wybranym okresie. Dane pobierane z hurtowni danych (DWH).',
 'Partner Performance – Obrót brutto (PLN)',
 '', 'string', 'tooltip'),

('crm.partners.kpi.revenue',
 'Przychód netto (marża) wygenerowany przez partnerów — różnica między obrotem brutto a prowizjami wypłaconymi partnerom. Procent marży wyświetlany jest pod wartością.',
 'Partner Performance – Przychód / Marża (PLN)',
 '', 'string', 'tooltip'),

('crm.partners.kpi.fees',
 'Łączna kwota prowizji (fees) wypłacona partnerom w wybranym okresie. Stanowi wynagrodzenie partnerów za wygenerowaną sprzedaż.',
 'Partner Performance – Fees (PLN)',
 '', 'string', 'tooltip'),

('crm.partners.kpi.transactions',
 'Liczba transakcji sprzedażowych zrealizowanych przez wszystkich partnerów w wybranym okresie.',
 'Partner Performance – Transakcje',
 '', 'string', 'tooltip'),

('crm.partners.kpi.active_partners',
 'Liczba partnerów, którzy wygenerowali co najmniej jedną transakcję w wybranym okresie.',
 'Partner Performance – Aktywnych partnerów',
 '', 'string', 'tooltip'),

('crm.partners.scorecard.health',
 'Wskaźnik kondycji partnera oparty na obrocie brutto: zielony – powyżej 500 tys. PLN, żółty – 100–500 tys. PLN, czerwony – poniżej 100 tys. PLN.',
 'Partner Performance – Scorecard: Health',
 '', 'string', 'tooltip'),

-- ─── Raporty sprzedaży – KPI ─────────────────────────────────────────────────

('crm.leads.kpi.pipeline',
 'Łączna szacowana wartość wszystkich aktywnych leadów w pipeline (poza Nowe i Przegrane/Wygrane) w wybranym filtrze. Kliknij wartość, aby przejść do listy tych leadów.',
 'Raporty sprzedaży – KPI: Pipeline (PLN)',
 '', 'string', 'tooltip'),

('crm.leads.kpi.won',
 'Łączna wartość kontraktów wygranych (Closed Won) w wybranym okresie. Liczba kontraktów wyświetlana jest pod wartością. Kliknij, aby zobaczyć listę.',
 'Raporty sprzedaży – KPI: Zamknięte / Won (PLN)',
 '', 'string', 'tooltip'),

('crm.leads.kpi.win_rate',
 'Stosunek wygranych leadów do wszystkich zamkniętych (wygranych + przegranych) w wybranym okresie. Obliczany jako: Wygrane ÷ (Wygrane + Przegrane) × 100%.',
 'Raporty sprzedaży – KPI: Win Rate',
 '', 'string', 'tooltip'),

('crm.leads.kpi.avg_cycle',
 'Średnia liczba dni od wejścia leada w etap Kwalifikacja do zamknięcia jako Wygrany. Etap Nowy traktowany jest jako poczekalnia i nie wlicza się do cyklu. Uwzględniane są wyłącznie wygrane leady.',
 'Raporty sprzedaży – KPI: Avg. cykl sprzedaży',
 '', 'string', 'tooltip'),

('crm.leads.kpi.budget',
 'Planowany target sprzedażowy (budżet) dla wybranego okresu i handlowca. Pasek postępu pokazuje realizację: Won ÷ Budżet × 100%. Budżety definiowane są w sekcji Budżety sprzedaży.',
 'Raporty sprzedaży – KPI: Planowany budżet (PLN)',
 '', 'string', 'tooltip'),

-- ─── Raporty sprzedaży – Lejek ───────────────────────────────────────────────

('crm.leads.funnel.title',
 'Wizualizacja liczby leadów i ich łącznej wartości (PLN) na każdym etapie procesu sprzedaży. Szerokość paska odpowiada proporcji do etapu z największą liczbą leadów. Kliknij pasek, aby zobaczyć leady na danym etapie.',
 'Raporty sprzedaży – Lejek sprzedażowy (tytuł)',
 '', 'string', 'tooltip'),

('crm.leads.funnel.pct',
 'Wartość % po prawej stronie paska to konwersja do następnego etapu — jaki odsetek leadów przeszedł z bieżącego etapu do kolejnego w wybranym filtrze. Wartość powyżej 100% oznacza, że do kolejnego etapu dotarło więcej leadów, niż aktualnie jest na bieżącym (np. przez wcześniejsze przesunięcia).',
 'Raporty sprzedaży – Lejek: % konwersji między etapami',
 '', 'string', 'tooltip'),

('crm.leads.funnel.conversion',
 'Ogólna konwersja — jaki procent wszystkich zamkniętych leadów zakończył się wygraną (Closed Won). Identyczna wartość jak Win Rate w sekcji KPI powyżej.',
 'Raporty sprzedaży – Lejek: Konwersja do Wygranego',
 '', 'string', 'tooltip'),

('crm.leads.funnel.avg_won',
 'Średnia wartość wygranego kontraktu — łączna wartość wygranych podzielona przez liczbę wygranych leadów w wybranym filtrze.',
 'Raporty sprzedaży – Lejek: Avg. wartość wygranego',
 '', 'string', 'tooltip'),

('crm.leads.funnel.active',
 'Liczba leadów w aktywnych etapach (Nowy, Kwalifikacja, Prezentacja, Oferta, Negocjacje) — czyli jeszcze nierozstrzygniętych.',
 'Raporty sprzedaży – Lejek: Aktywne leady',
 '', 'string', 'tooltip'),

('crm.leads.funnel.hot',
 'Liczba leadów oznaczonych jako Gorące (🔥) — wymagające priorytetowej uwagi handlowca. Flaga ustawiana ręcznie na karcie leada.',
 'Raporty sprzedaży – Lejek: Gorące leady',
 '', 'string', 'tooltip'),

-- ─── Raporty sprzedaży – Trend miesięczny ────────────────────────────────────

('crm.leads.trend.title',
 'Wykres słupkowy za ostatnie 12 miesięcy. Słupki grupowane są po miesiącu, w którym lead wszedł w etap Kwalifikacja — nie po dacie utworzenia. Niebieski — leady aktualnie w etapach Kwalifikacja, Prezentacja, Oferta lub Negocjacje. Pomarańczowy — wygrane (Won). Leady w etapie Nowy nie są wyświetlane.',
 'Raporty sprzedaży – Trend miesięczny (tytuł)',
 '', 'string', 'tooltip'),

-- ─── Raporty sprzedaży – Wyniki handlowców ───────────────────────────────────

('crm.leads.reps.title',
 'Tabela porównująca wyniki poszczególnych handlowców w wybranym filtrze. Kliknij wiersz, aby zobaczyć leady przypisane do danego handlowca.',
 'Raporty sprzedaży – Wyniki handlowców (tytuł)',
 '', 'string', 'tooltip'),

('crm.leads.reps.col.leads',
 'Łączna liczba leadów przypisanych do handlowca w wybranym filtrze (aktywne i zamknięte).',
 'Raporty sprzedaży – Handlowcy: kolumna Leady',
 '', 'string', 'tooltip'),

('crm.leads.reps.col.pipeline',
 'Łączna wartość aktywnych leadów (pipeline) przypisanych do handlowca — szacowana wartość potencjalnych kontraktów.',
 'Raporty sprzedaży – Handlowcy: kolumna Pipeline',
 '', 'string', 'tooltip'),

('crm.leads.reps.col.won',
 'Łączna wartość wygranych kontraktów (Closed Won) przypisanych do handlowca w wybranym filtrze.',
 'Raporty sprzedaży – Handlowcy: kolumna Won',
 '', 'string', 'tooltip'),

('crm.leads.reps.col.win_rate',
 'Skuteczność handlowca — procent wygranych spośród wszystkich zamkniętych leadów: Wygrane ÷ (Wygrane + Przegrane) × 100%.',
 'Raporty sprzedaży – Handlowcy: kolumna Win%',
 '', 'string', 'tooltip'),

('crm.leads.reps.col.progress',
 'Wizualizacja Win% jako pasek postępu. Kolor zmienia się w zależności od skuteczności: zielony ≥ 50%, żółty 25–50%, czerwony poniżej 25%.',
 'Raporty sprzedaży – Handlowcy: kolumna Postęp',
 '', 'string', 'tooltip'),

-- ─── Raporty sprzedaży – Źródła leadów ──────────────────────────────────────

('crm.leads.sources.title',
 'Podział liczby leadów według źródła pozyskania (np. strona WWW, LinkedIn, polecenie). Pomaga ocenić, które kanały przynoszą najwięcej leadów.',
 'Raporty sprzedaży – Źródła leadów (tytuł)',
 '', 'string', 'tooltip'),

('crm.leads.sources.quality',
 'Win rate dla każdego źródła leadów — jaki procent leadów z danego kanału kończy się wygraną. Pozwala ocenić jakość (nie tylko ilość) pozyskiwanych leadów z poszczególnych kanałów.',
 'Raporty sprzedaży – Źródła: Jakość po źródle (win rate)',
 '', 'string', 'tooltip'),

-- ─── Raporty sprzedaży – Czas w etapie ──────────────────────────────────────

('crm.leads.velocity.title',
 'Średnia liczba dni, jaką leady spędzają na każdym etapie procesu sprzedaży. Długi czas na danym etapie może wskazywać na wąskie gardło w procesie.',
 'Raporty sprzedaży – Czas w etapie (tytuł)',
 '', 'string', 'tooltip'),

-- ─── Raporty sprzedaży – Powody przegranej ───────────────────────────────────

('crm.leads.lost.title',
 'Zestawienie przyczyn, dla których leady zostały oznaczone jako przegrane (Closed Lost). Pomaga identyfikować najczęstsze bariery sprzedażowe i poprawić proces.',
 'Raporty sprzedaży – Powody przegranej (tytuł)',
 '', 'string', 'tooltip')

ON CONFLICT (key) DO NOTHING;
