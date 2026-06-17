-- 0197_demo_refresh.sql
-- Dane demo dla prezentacji klienta — czerwiec 2026.
-- Addytywne: tworzy nowe leady, partnerów, dokumenty, aktywności, zadania.
-- Nie usuwa istniejących danych.
-- Rewrite v4: diagnostic stage tracking + no array operations.

DO $$
DECLARE
  v_stage  TEXT := 'init';
  v_tid    UUID;
  v_u1     UUID;
  v_u2     UUID;
  v_gid    UUID;
  run_tag  TEXT;
  doc_pfx  TEXT;
  -- lead IDs (crm_leads.id is INTEGER)
  l1 INTEGER; l2 INTEGER; l3 INTEGER; l4 INTEGER;
  l5 INTEGER; l6 INTEGER; l7 INTEGER;
  -- partner IDs (crm_partners.id is UUID — changed from SERIAL in a later migration)
  p1 UUID; p2 UUID; p3 UUID; p4 UUID;
  -- document IDs (UUID)
  d1 UUID; d2 UUID; d3 UUID; d4 UUID; d5 UUID;
BEGIN
  v_stage := 'tenant';
  SELECT id INTO v_tid FROM tenants WHERE slug = 'crmtree-gold';
  IF v_tid IS NULL THEN
    RAISE NOTICE '0197: tenant not found — skipping'; RETURN;
  END IF;

  v_stage := 'user1';
  SELECT id INTO v_u1 FROM users
    WHERE tenant_id = v_tid AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_u1 IS NULL THEN
    RAISE NOTICE '0197: no users — skipping'; RETURN;
  END IF;

  v_stage := 'user2';
  SELECT id INTO v_u2 FROM users
    WHERE tenant_id = v_tid AND is_active = true AND id <> v_u1 ORDER BY created_at LIMIT 1;
  IF v_u2 IS NULL THEN v_u2 := v_u1; END IF;

  v_stage := 'group';
  SELECT id INTO v_gid FROM group_profiles
    WHERE tenant_id = v_tid AND is_active = true LIMIT 1;

  run_tag := 'DEMO-2026-' || to_char(now(), 'MMDD');
  doc_pfx := 'DOC-DEMO-' || to_char(now(), 'YYYYMMDD-HH24MI');

  -- ── 1. New leads ─────────────────────────────────────────────────────────────
  v_stage := 'lead_1';
  INSERT INTO crm_leads (company, contact_name, contact_title, email, phone, source, stage, value_pln, probability, close_date, industry, assigned_to, hot, notes, created_by, created_at, updated_at, tenant_id)
  VALUES ('Eurosport Travel Group Sp. z o.o.','Anna Kowalska','Dyrektor ds. Zakupów','kontakt@eurosport.pl','+48 500 123 456','direct','new',150000,10,(now()+45*interval'1 day')::date,'Turystyka korporacyjna',v_u1,true,'['||run_tag||'] Lead demo.',v_u1,now()-7*interval'1 day',now(),v_tid)
  RETURNING id INTO l1;

  v_stage := 'lead_2';
  INSERT INTO crm_leads (company, contact_name, contact_title, email, phone, source, stage, value_pln, probability, close_date, industry, assigned_to, hot, notes, created_by, created_at, updated_at, tenant_id)
  VALUES ('TechCorp Solutions S.A.','Piotr Wiśniewski','CFO','kontakt@techcorp.pl','+48 501 234 567','recommendation','new',280000,10,(now()+60*interval'1 day')::date,'IT / Software',v_u2,true,'['||run_tag||'] Lead demo.',v_u2,now()-12*interval'1 day',now(),v_tid)
  RETURNING id INTO l2;

  v_stage := 'lead_3';
  INSERT INTO crm_leads (company, contact_name, contact_title, email, phone, source, stage, value_pln, probability, close_date, industry, assigned_to, hot, notes, created_by, created_at, updated_at, tenant_id)
  VALUES ('BlueSky Consulting Sp. z o.o.','Katarzyna Wójcik','CEO','kontakt@bluesky.pl','+48 502 345 678','website','qualification',90000,25,(now()+90*interval'1 day')::date,'Usługi profesjonalne',v_u1,false,'['||run_tag||'] Lead demo.',v_u1,now()-5*interval'1 day',now(),v_tid)
  RETURNING id INTO l3;

  v_stage := 'lead_4';
  INSERT INTO crm_leads (company, contact_name, contact_title, email, phone, source, stage, value_pln, probability, close_date, industry, assigned_to, hot, notes, created_by, created_at, updated_at, tenant_id)
  VALUES ('Meridian Business Travel S.A.','Marek Kowalczyk','Office Manager','kontakt@meridian.pl','+48 503 456 789','partner','qualification',420000,25,(now()+75*interval'1 day')::date,'Transport i logistyka',v_u2,false,'['||run_tag||'] Lead demo.',v_u2,now()-8*interval'1 day',now(),v_tid)
  RETURNING id INTO l4;

  v_stage := 'lead_5';
  INSERT INTO crm_leads (company, contact_name, contact_title, email, phone, source, stage, value_pln, probability, close_date, industry, assigned_to, hot, notes, created_by, created_at, updated_at, tenant_id)
  VALUES ('Nexus Corporate Services Sp. z o.o.','Joanna Kamińska','Travel Manager','kontakt@nexus.pl','+48 504 567 890','conference','presentation',330000,40,(now()+50*interval'1 day')::date,'Finanse i bankowość',v_u1,false,'['||run_tag||'] Lead demo.',v_u1,now()-3*interval'1 day',now(),v_tid)
  RETURNING id INTO l5;

  v_stage := 'lead_6';
  INSERT INTO crm_leads (company, contact_name, contact_title, email, phone, source, stage, value_pln, probability, close_date, industry, assigned_to, hot, notes, created_by, created_at, updated_at, tenant_id)
  VALUES ('Orbit Finance Group S.A.','Tomasz Lewandowski','Kierownik ds. Podróży','kontakt@orbit.pl','+48 505 678 901','direct','offer',180000,60,(now()+35*interval'1 day')::date,'Finanse i bankowość',v_u2,false,'['||run_tag||'] Lead demo.',v_u2,now()-14*interval'1 day',now(),v_tid)
  RETURNING id INTO l6;

  v_stage := 'lead_7';
  INSERT INTO crm_leads (company, contact_name, contact_title, email, phone, source, stage, value_pln, probability, close_date, industry, assigned_to, hot, notes, created_by, created_at, updated_at, tenant_id)
  VALUES ('PKP Korporacyjne Sp. z o.o.','Agnieszka Zielińska','Dyrektor Operacyjny','kontakt@pkp.pl','+48 506 789 012','recommendation','negotiation',500000,75,(now()+120*interval'1 day')::date,'Transport i logistyka',v_u1,false,'['||run_tag||'] Lead demo.',v_u1,now()-6*interval'1 day',now(),v_tid)
  RETURNING id INTO l7;

  -- ── 2. New partners ───────────────────────────────────────────────────────────
  v_stage := 'partner_1';
  INSERT INTO crm_partners (company, nip, address, contact_name, contact_title, email, phone, industry, manager_id, status, onboarding_step, notes, created_by, created_at, updated_at, tenant_id)
  VALUES ('VentureWorks Polska Sp. z o.o.','5252345678','ul. Marszałkowska 12, Warszawa','Anna Nowak','Office Manager','biuro@ventureworks.pl','+48 222 100 200','Transport i logistyka',v_u1,'onboarding',0,'['||run_tag||'] Partner demo.',v_u1,now()-10*interval'1 day',now(),v_tid)
  RETURNING id INTO p1;

  v_stage := 'partner_2';
  INSERT INTO crm_partners (company, nip, address, contact_name, contact_title, email, phone, industry, manager_id, status, onboarding_step, notes, created_by, created_at, updated_at, tenant_id)
  VALUES ('AlphaRoute Business Travel S.A.','7811234567','ul. Nowy Świat 45, Warszawa','Jan Kowalski','Travel Manager','biuro@alpharoute.pl','+48 222 200 300','Turystyka korporacyjna',v_u2,'onboarding',0,'['||run_tag||'] Partner demo.',v_u2,now()-7*interval'1 day',now(),v_tid)
  RETURNING id INTO p2;

  v_stage := 'partner_3';
  INSERT INTO crm_partners (company, nip, address, contact_name, contact_title, email, phone, industry, manager_id, status, onboarding_step, notes, created_by, created_at, updated_at, tenant_id)
  VALUES ('Sigma Logistics Partners Sp. z o.o.','6762345678','ul. Puławska 78, Warszawa','Maria Wiśniewska','Dyrektor Operacyjny','biuro@sigmalogistics.pl','+48 222 300 400','Transport i logistyka',v_u1,'onboarding',1,'['||run_tag||'] Partner demo.',v_u1,now()-14*interval'1 day',now(),v_tid)
  RETURNING id INTO p3;

  v_stage := 'partner_4';
  INSERT INTO crm_partners (company, nip, address, contact_name, contact_title, email, phone, industry, manager_id, status, onboarding_step, notes, created_by, created_at, updated_at, tenant_id)
  VALUES ('Prime Mobility Solutions S.A.','5261234567','ul. Mokotowska 22, Warszawa','Piotr Nowak','Koordynator ds. Podróży','biuro@primemobility.pl','+48 222 400 500','Usługi profesjonalne',v_u2,'active',3,'['||run_tag||'] Partner demo.',v_u2,now()-20*interval'1 day',now(),v_tid)
  RETURNING id INTO p4;

  -- ── 3. New documents ─────────────────────────────────────────────────────────
  v_stage := 'doc_1';
  d1 := gen_random_uuid();
  INSERT INTO documents (id, doc_number, name, doc_type, entities, owner_id, group_id, gdpr_type, status, creation_date, blob_path, blob_name, blob_size_bytes, mime_type, country, created_by, created_at, updated_at, tenant_id)
  VALUES (d1, doc_pfx||'-01','Umowa partnerska — VentureWorks Polska','partner_agreement','{}',v_u1,v_gid,'no_gdpr','being_edited',CURRENT_DATE-7,'demo/'||d1::text||'/file.pdf','demo_01.pdf',0,'application/pdf','Polska',v_u1,now()-7*interval'1 day',now(),v_tid);

  v_stage := 'doc_2';
  d2 := gen_random_uuid();
  INSERT INTO documents (id, doc_number, name, doc_type, entities, owner_id, group_id, gdpr_type, status, creation_date, blob_path, blob_name, blob_size_bytes, mime_type, country, created_by, created_at, updated_at, tenant_id)
  VALUES (d2, doc_pfx||'-02','NDA — AlphaRoute Business Travel','nda','{}',v_u2,v_gid,'no_gdpr','new',CURRENT_DATE-5,'demo/'||d2::text||'/file.pdf','demo_02.pdf',0,'application/pdf','Polska',v_u2,now()-5*interval'1 day',now(),v_tid);

  v_stage := 'doc_3';
  d3 := gen_random_uuid();
  INSERT INTO documents (id, doc_number, name, doc_type, entities, owner_id, group_id, gdpr_type, status, creation_date, blob_path, blob_name, blob_size_bytes, mime_type, country, created_by, created_at, updated_at, tenant_id)
  VALUES (d3, doc_pfx||'-03','Umowa IT — Sigma Logistics Partners','it_supplier_agreement','{}',v_u1,v_gid,'no_gdpr','new',CURRENT_DATE-3,'demo/'||d3::text||'/file.pdf','demo_03.pdf',0,'application/pdf','Polska',v_u1,now()-3*interval'1 day',now(),v_tid);

  v_stage := 'doc_4';
  d4 := gen_random_uuid();
  INSERT INTO documents (id, doc_number, name, doc_type, entities, owner_id, group_id, gdpr_type, status, creation_date, blob_path, blob_name, blob_size_bytes, mime_type, country, created_by, created_at, updated_at, tenant_id)
  VALUES (d4, doc_pfx||'-04','Umowa partnerska — Prime Mobility Solutions','partner_agreement','{}',v_u2,v_gid,'no_gdpr','signed',CURRENT_DATE-14,'demo/'||d4::text||'/file.pdf','demo_04.pdf',0,'application/pdf','Polska',v_u2,now()-14*interval'1 day',now(),v_tid);

  v_stage := 'doc_5';
  d5 := gen_random_uuid();
  INSERT INTO documents (id, doc_number, name, doc_type, entities, owner_id, group_id, gdpr_type, status, creation_date, blob_path, blob_name, blob_size_bytes, mime_type, country, created_by, created_at, updated_at, tenant_id)
  VALUES (d5, doc_pfx||'-05','Umowa operatorska — Meridian Business Travel','operator_agreement','{}',v_u1,v_gid,'no_gdpr','being_edited',CURRENT_DATE-2,'demo/'||d5::text||'/file.pdf','demo_05.pdf',0,'application/pdf','Polska',v_u1,now()-2*interval'1 day',now(),v_tid);

  -- ── Link docs to partners ─────────────────────────────────────────────────────
  v_stage := 'partner_docs_link';
  INSERT INTO crm_partner_documents (partner_id, document_id, doc_role, linked_by, tenant_id) VALUES
    (p1, d1, 'main_contract', v_u1, v_tid),
    (p2, d2, 'main_contract', v_u1, v_tid),
    (p3, d3, 'main_contract', v_u1, v_tid),
    (p4, d4, 'main_contract', v_u1, v_tid)
  ON CONFLICT (partner_id, document_id) DO NOTHING;

  -- ── Link docs to leads ────────────────────────────────────────────────────────
  v_stage := 'lead_docs_link';
  INSERT INTO crm_lead_documents (lead_id, document_id, doc_role, linked_by, tenant_id) VALUES
    (l1, d1, 'offer_document', v_u1, v_tid),
    (l2, d2, 'offer_document', v_u1, v_tid),
    (l3, d3, 'offer_document', v_u1, v_tid),
    (l4, d4, 'offer_document', v_u1, v_tid),
    (l5, d5, 'offer_document', v_u1, v_tid)
  ON CONFLICT (lead_id, document_id) DO NOTHING;

  -- ── 4. Lead activities ────────────────────────────────────────────────────────
  v_stage := 'lead_acts_1';
  INSERT INTO crm_lead_activities (lead_id, type, title, body, activity_at, status, assigned_to, created_by, created_at, tenant_id)
  SELECT id, 'call', 'Rozmowa telefoniczna — czerwiec 2026',
         'Omówiono potrzeby klienta. Zainteresowanie ofertą premium. Umówiono follow-up.',
         NULL, 'open', v_u1, v_u1, now(), v_tid
  FROM crm_leads WHERE tenant_id = v_tid ORDER BY created_at DESC LIMIT 20;

  v_stage := 'lead_acts_2';
  INSERT INTO crm_lead_activities (lead_id, type, title, body, activity_at, status, assigned_to, created_by, created_at, tenant_id)
  SELECT id, 'email', 'Wysłanie materiałów ofertowych — czerwiec 2026',
         'Przesłano prezentację i cennik. Klient potwierdził odbiór. Analiza w 5 dni.',
         NULL, 'new', v_u2, v_u2, now(), v_tid
  FROM crm_leads WHERE tenant_id = v_tid ORDER BY created_at DESC LIMIT 20;

  v_stage := 'lead_acts_3';
  INSERT INTO crm_lead_activities (lead_id, type, title, body, activity_at, status, assigned_to, created_by, created_at, tenant_id)
  SELECT id, 'meeting', 'Demo platformy — spotkanie online',
         'Zaprezentowano system. Pytania o integrację SAP. Umówiono pilotaż 30 dni.',
         (now()-3*interval'1 day')::timestamptz, 'closed', v_u1, v_u1, now(), v_tid
  FROM crm_leads WHERE tenant_id = v_tid ORDER BY created_at DESC LIMIT 10;

  -- ── 5. Partner activities ─────────────────────────────────────────────────────
  v_stage := 'partner_acts_1';
  INSERT INTO crm_partner_activities (partner_id, type, title, body, activity_at, status, assigned_to, created_by, created_at, tenant_id)
  SELECT id, 'call', 'Monthly check-in — czerwiec 2026',
         'Wyniki za ostatni miesiąc. Wolumen transakcji +12%. Brak zgłoszeń technicznych.',
         NULL, 'closed', v_u1, v_u1, now(), v_tid
  FROM crm_partners WHERE tenant_id = v_tid ORDER BY created_at DESC LIMIT 20;

  v_stage := 'partner_acts_2';
  INSERT INTO crm_partner_activities (partner_id, type, title, body, activity_at, status, assigned_to, created_by, created_at, tenant_id)
  SELECT id, 'email', 'Newsletter — nowości platformy czerwiec 2026',
         'Nowe funkcje: integracja Google Calendar, eksport PDF raportów, moduł onboardingu v2.',
         NULL, 'new', v_u2, v_u2, now(), v_tid
  FROM crm_partners WHERE tenant_id = v_tid ORDER BY created_at DESC LIMIT 20;

  v_stage := 'partner_acts_3';
  INSERT INTO crm_partner_activities (partner_id, type, title, body, activity_at, status, assigned_to, created_by, created_at, tenant_id)
  SELECT id, 'meeting', 'QBR — kwartalny przegląd biznesowy Q2 2026',
         'Wyniki Q2, plany Q3. Partner planuje rozszerzenie o 50 licencji od Q4 2026.',
         (now()-5*interval'1 day')::timestamptz, 'closed', v_u1, v_u1, now(), v_tid
  FROM crm_partners WHERE tenant_id = v_tid ORDER BY created_at DESC LIMIT 10;

  -- ── 6. Onboarding tasks ───────────────────────────────────────────────────────
  -- p1 VentureWorks (step 0)
  v_stage := 'onboard_p1';
  INSERT INTO crm_onboarding_tasks (partner_id, step, title, type, assigned_to, due_date, done, created_by, created_at, tenant_id) VALUES
    (p1, 0, 'Podpisanie umowy głównej',         'task', v_u1, CURRENT_DATE+5,  false, v_u1, now(), v_tid),
    (p1, 0, 'Weryfikacja NIP i dokumentów KRS', 'task', v_u2, CURRENT_DATE+7,  false, v_u2, now(), v_tid),
    (p1, 0, 'Kick-off call z Account Manager',  'call', v_u1, CURRENT_DATE+3,  false, v_u1, now(), v_tid);

  -- p2 AlphaRoute (step 0)
  v_stage := 'onboard_p2';
  INSERT INTO crm_onboarding_tasks (partner_id, step, title, type, assigned_to, due_date, done, created_by, created_at, tenant_id) VALUES
    (p2, 0, 'Podpisanie umowy głównej',         'task', v_u2, CURRENT_DATE+7,  false, v_u2, now(), v_tid),
    (p2, 0, 'Weryfikacja NIP i dokumentów KRS', 'task', v_u1, CURRENT_DATE+10, false, v_u1, now(), v_tid);

  -- p3 Sigma (step 1, step 0 done)
  v_stage := 'onboard_p3_done';
  INSERT INTO crm_onboarding_tasks (partner_id, step, title, type, assigned_to, due_date, done, done_at, created_by, created_at, tenant_id) VALUES
    (p3, 0, 'Podpisanie umowy głównej',         'task', v_u1, CURRENT_DATE-10, true, now()-8*interval'1 day', v_u1, now(), v_tid),
    (p3, 0, 'Weryfikacja NIP i dokumentów KRS', 'task', v_u2, CURRENT_DATE-8,  true, now()-6*interval'1 day', v_u2, now(), v_tid),
    (p3, 0, 'Kick-off call z Account Manager',  'call', v_u1, CURRENT_DATE-7,  true, now()-5*interval'1 day', v_u1, now(), v_tid);

  v_stage := 'onboard_p3_pending';
  INSERT INTO crm_onboarding_tasks (partner_id, step, title, type, assigned_to, due_date, done, created_by, created_at, tenant_id) VALUES
    (p3, 1, 'Konfiguracja kont użytkowników',   'task',     v_u1, CURRENT_DATE+5,  false, v_u1, now(), v_tid),
    (p3, 1, 'Ustawienie polityk podróżniczych', 'task',     v_u2, CURRENT_DATE+7,  false, v_u2, now(), v_tid),
    (p3, 1, 'Szkolenie administratora systemu', 'training', v_u1, CURRENT_DATE+10, false, v_u1, now(), v_tid);

  -- existing onboarding partners
  v_stage := 'onboard_existing';
  INSERT INTO crm_onboarding_tasks (partner_id, step, title, type, assigned_to, due_date, done, created_by, created_at, tenant_id)
  SELECT id, onboarding_step, '[Czerwiec 2026] Weryfikacja postępu wdrożenia',
         'task', v_u1, CURRENT_DATE+7, false, v_u1, now(), v_tid
  FROM crm_partners
  WHERE tenant_id = v_tid AND status = 'onboarding'
    AND id NOT IN (p1, p2, p3, p4)
  ORDER BY created_at DESC LIMIT 5;

  -- ── 7. Workflow tasks — new documents ─────────────────────────────────────────
  v_stage := 'wf_read';
  INSERT INTO workflow_tasks (id, document_id, assigned_by, assigned_to, task_type, task_status, message, due_date, created_at, updated_at, tenant_id) VALUES
    (gen_random_uuid(), d1, v_u1, v_u2, 'read'::workflow_task_type, 'pending', 'Proszę o zapoznanie się z dokumentem i potwierdzenie odbioru.', CURRENT_DATE+7, now(), now(), v_tid),
    (gen_random_uuid(), d2, v_u1, v_u2, 'read'::workflow_task_type, 'pending', 'Proszę o zapoznanie się z dokumentem i potwierdzenie odbioru.', CURRENT_DATE+7, now(), now(), v_tid),
    (gen_random_uuid(), d3, v_u1, v_u2, 'read'::workflow_task_type, 'pending', 'Proszę o zapoznanie się z dokumentem i potwierdzenie odbioru.', CURRENT_DATE+7, now(), now(), v_tid),
    (gen_random_uuid(), d4, v_u1, v_u2, 'read'::workflow_task_type, 'pending', 'Proszę o zapoznanie się z dokumentem i potwierdzenie odbioru.', CURRENT_DATE+7, now(), now(), v_tid),
    (gen_random_uuid(), d5, v_u1, v_u2, 'read'::workflow_task_type, 'pending', 'Proszę o zapoznanie się z dokumentem i potwierdzenie odbioru.', CURRENT_DATE+7, now(), now(), v_tid);

  v_stage := 'wf_approve';
  INSERT INTO workflow_tasks (id, document_id, assigned_by, assigned_to, task_type, task_status, message, due_date, created_at, updated_at, tenant_id) VALUES
    (gen_random_uuid(), d1, v_u2, v_u1, 'approve'::workflow_task_type, 'pending', 'Dokument wymaga zatwierdzenia przed wysłaniem do klienta.', CURRENT_DATE+10, now(), now(), v_tid),
    (gen_random_uuid(), d2, v_u2, v_u1, 'approve'::workflow_task_type, 'pending', 'Dokument wymaga zatwierdzenia przed wysłaniem do klienta.', CURRENT_DATE+10, now(), now(), v_tid),
    (gen_random_uuid(), d3, v_u2, v_u1, 'approve'::workflow_task_type, 'pending', 'Dokument wymaga zatwierdzenia przed wysłaniem do klienta.', CURRENT_DATE+10, now(), now(), v_tid);

  v_stage := 'wf_sign_existing';
  INSERT INTO workflow_tasks (id, document_id, assigned_by, assigned_to, task_type, task_status, message, due_date, created_at, updated_at, tenant_id)
  SELECT gen_random_uuid(), id, v_u1, v_u2,
         'sign'::workflow_task_type, 'pending',
         'Dokument gotowy do podpisu — proszę o finalizację.',
         CURRENT_DATE+14, now(), now(), v_tid
  FROM documents
  WHERE tenant_id = v_tid
    AND deleted_at IS NULL
    AND id NOT IN (d1, d2, d3, d4, d5)
  ORDER BY created_at DESC LIMIT 10;

  v_stage := 'done';

EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION '0197 failed at stage [%]: %', v_stage, SQLERRM;
END $$;
