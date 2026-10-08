-- ============================================================
-- 0314 — INT only: demo data for the Projects module, in English
--
-- The `brmtree-test1` tenant on INT is used to show the product to a
-- foreign customer. This gives it six projects that look alive: tasks in
-- every status (done, in progress, in review, overdue, due today, planned),
-- subtasks, links to partners and leads, team chats, and custom fields of
-- all five types with values on every task. "Adam Admin" is in every
-- project and owns tasks in each state.
--
-- The tenant's task statuses, types and priorities are renamed to English
-- (or created in English when the tenant had none yet).
--
-- A seed shipped as a migration because the INT database is reachable only
-- from the deploy pipeline. It does nothing anywhere else: the first check
-- is the database name, the second the tenant. Safe to re-run by hand: the
-- demo projects have fixed ids and are replaced, never duplicated; projects
-- created by people are not touched.
-- ============================================================

DO $$
DECLARE
  v_tenant     uuid;
  v_adam       uuid;
  v_users      uuid[];   -- [1] is Adam; "slot n" below means v_users[1 + n % count]
  v_user_count integer;
  v_partners   uuid[];
  v_leads      integer[];
  v_workstream text[] := ARRAY['Discovery', 'Configuration', 'Integration', 'Training', 'Go-live'];
  v_field_ref  uuid;
  v_field_hrs  uuid;
  v_field_ws   uuid;
  v_field_due  uuid;
  v_field_bud  uuid;
  v_project    uuid;
  v_task       uuid;
  v_pm         uuid;
  v_slot       integer;
  v_created    integer := 0;
  r            record;
  i            integer;
BEGIN
  IF current_database() <> 'crmtreedb_int' THEN
    RAISE NOTICE '0314: not the INT database (%), nothing to seed', current_database();
    RETURN;
  END IF;

  SELECT id INTO v_tenant FROM tenants WHERE slug = 'brmtree-test1' AND deleted_at IS NULL;
  IF v_tenant IS NULL THEN
    RAISE NOTICE '0314: tenant brmtree-test1 not found, nothing to seed';
    RETURN;
  END IF;

  -- ── People ────────────────────────────────────────────────────────────
  SELECT id INTO v_adam FROM users
   WHERE tenant_id = v_tenant AND is_active
     AND lower(first_name) = 'adam' AND lower(last_name) = 'admin'
   ORDER BY created_at LIMIT 1;
  IF v_adam IS NULL THEN
    SELECT id INTO v_adam FROM users
     WHERE tenant_id = v_tenant AND is_active AND is_admin ORDER BY created_at LIMIT 1;
  END IF;
  IF v_adam IS NULL THEN
    RAISE NOTICE '0314: no admin user in brmtree-test1, nothing to seed';
    RETURN;
  END IF;

  SELECT v_adam || COALESCE(array_agg(id ORDER BY email), '{}') INTO v_users
    FROM (SELECT id, email FROM users
           WHERE tenant_id = v_tenant AND is_active AND NOT is_external AND id <> v_adam
           ORDER BY email LIMIT 5) other_users;
  v_user_count := array_length(v_users, 1);

  SELECT COALESCE(array_agg(id ORDER BY company), '{}') INTO v_partners
    FROM (SELECT id, company FROM crm_partners
           WHERE tenant_id = v_tenant AND COALESCE(status, 'active') = 'active' AND company IS NOT NULL
           ORDER BY company LIMIT 3) p;
  SELECT COALESCE(array_agg(id ORDER BY company), '{}') INTO v_leads
    FROM (SELECT id, company FROM crm_leads
           WHERE tenant_id = v_tenant AND stage NOT IN ('closed_won', 'closed_lost', 'archived')
           ORDER BY company LIMIT 2) l;

  INSERT INTO tenant_features (tenant_id, feature, is_enabled)
  VALUES (v_tenant, 'projects', TRUE)
  ON CONFLICT (tenant_id, feature) DO UPDATE SET is_enabled = TRUE;

  -- ── Dictionaries in English ───────────────────────────────────────────
  -- The default Polish names are renamed in place, so tasks that already
  -- use them keep their status; whatever is still missing is created.
  FOR r IN SELECT * FROM (VALUES
      ('Do zrobienia',   'To do',       'todo',        '#6B7280', 0),
      ('W toku',         'In progress', 'in_progress', '#3B82F6', 1),
      ('Do weryfikacji', 'In review',   'in_progress', '#F59E0B', 2),
      ('Zakończone',     'Done',        'done',        '#3BAA5D', 3)
    ) AS s(polish, english, category, color, sort_order)
  LOOP
    UPDATE project_task_statuses SET name = r.english, updated_at = now()
     WHERE tenant_id = v_tenant AND name = r.polish
       AND NOT EXISTS (SELECT 1 FROM project_task_statuses WHERE tenant_id = v_tenant AND name = r.english);
    INSERT INTO project_task_statuses (tenant_id, name, category, color, sort_order)
    VALUES (v_tenant, r.english, r.category, r.color, r.sort_order)
    ON CONFLICT (tenant_id, name) DO NOTHING;
  END LOOP;

  FOR r IN SELECT * FROM (VALUES
      ('Zadanie', 'Task', '#3B82F6', 0), ('Spotkanie', 'Meeting', '#8B5CF6', 1), ('Kamień milowy', 'Milestone', '#F59E0B', 2)
    ) AS t(polish, english, color, sort_order)
  LOOP
    UPDATE project_task_types SET name = r.english, updated_at = now()
     WHERE tenant_id = v_tenant AND name = r.polish
       AND NOT EXISTS (SELECT 1 FROM project_task_types WHERE tenant_id = v_tenant AND name = r.english);
    INSERT INTO project_task_types (tenant_id, name, color, sort_order)
    VALUES (v_tenant, r.english, r.color, r.sort_order)
    ON CONFLICT (tenant_id, name) DO NOTHING;
  END LOOP;

  FOR r IN SELECT * FROM (VALUES
      ('Niski', 'Low', '#6B7280', 0), ('Średni', 'Medium', '#3B82F6', 1),
      ('Wysoki', 'High', '#F59E0B', 2), ('Krytyczny', 'Critical', '#DC2626', 3)
    ) AS p(polish, english, color, sort_order)
  LOOP
    UPDATE project_task_priorities SET name = r.english, updated_at = now()
     WHERE tenant_id = v_tenant AND name = r.polish
       AND NOT EXISTS (SELECT 1 FROM project_task_priorities WHERE tenant_id = v_tenant AND name = r.english);
    INSERT INTO project_task_priorities (tenant_id, name, color, sort_order)
    VALUES (v_tenant, r.english, r.color, r.sort_order)
    ON CONFLICT (tenant_id, name) DO NOTHING;
  END LOOP;

  -- The same moves the product allows by default: participants work a task
  -- up to review, a controller accepts it or sends it back.
  INSERT INTO project_status_transitions (tenant_id, role, from_status_id, to_status_id)
  SELECT v_tenant, t.role, f.id, o.id
    FROM (VALUES
      ('internal_participant', 'To do', 'In progress'), ('internal_participant', 'In progress', 'To do'),
      ('internal_participant', 'In progress', 'In review'),
      ('external_participant', 'To do', 'In progress'), ('external_participant', 'In progress', 'To do'),
      ('external_participant', 'In progress', 'In review'),
      ('controller', 'In review', 'Done'), ('controller', 'In review', 'In progress')
    ) AS t(role, from_name, to_name)
    JOIN project_task_statuses f ON f.tenant_id = v_tenant AND f.name = t.from_name
    JOIN project_task_statuses o ON o.tenant_id = v_tenant AND o.name = t.to_name
  ON CONFLICT DO NOTHING;

  -- ── Custom fields, one of each type ───────────────────────────────────
  INSERT INTO project_field_definitions (tenant_id, name, field_type, options, sort_order)
  VALUES
    (v_tenant, 'Customer reference', 'text',   '[]'::jsonb, 0),
    (v_tenant, 'Estimated hours',    'number', '[]'::jsonb, 1),
    (v_tenant, 'Workstream',         'list',   to_jsonb(v_workstream), 2),
    (v_tenant, 'Customer deadline',  'date',   '[]'::jsonb, 3),
    (v_tenant, 'Budget',             'money',  '[]'::jsonb, 4)
  ON CONFLICT (tenant_id, name) DO UPDATE SET is_active = TRUE;

  SELECT id INTO v_field_ref FROM project_field_definitions WHERE tenant_id = v_tenant AND name = 'Customer reference';
  SELECT id INTO v_field_hrs FROM project_field_definitions WHERE tenant_id = v_tenant AND name = 'Estimated hours';
  SELECT id INTO v_field_ws  FROM project_field_definitions WHERE tenant_id = v_tenant AND name = 'Workstream';
  SELECT id INTO v_field_due FROM project_field_definitions WHERE tenant_id = v_tenant AND name = 'Customer deadline';
  SELECT id INTO v_field_bud FROM project_field_definitions WHERE tenant_id = v_tenant AND name = 'Budget';

  -- ── Projects ──────────────────────────────────────────────────────────
  -- Fixed ids make a re-run replace the demo; tasks, members, fields and
  -- messages go with the project (ON DELETE CASCADE).
  FOR r IN SELECT * FROM (VALUES
      ('ONB', 'Customer onboarding',              'Getting the customer live in CRMtree: pipeline setup, data import, integrations and training. Target go-live in two weeks.', 'partner', 1, 0, FALSE),
      ('DMG', 'Data migration from legacy CRM',   'Moving companies, contacts and open deals out of the old system. A trial import first, the final import after the customer signs off the error list.', 'partner', 2, 1, FALSE),
      ('ERP', 'ERP integration rollout',          'Two-way synchronisation of orders and invoices between CRMtree and the customer''s ERP. Orders first, invoices second.', 'partner', 3, 0, FALSE),
      ('PLT', 'Pilot programme',                  'Three-week pilot with ten users. Success criteria: 10 active users and 50 logged activities.', 'lead', 1, 2, FALSE),
      ('RFP', 'RFP response and solution design', 'Response to the customer''s request for proposal: solution architecture, pricing and references. Submission on Friday.', 'lead', 2, 0, FALSE),
      ('QBR', 'Q3 business review',               'Quarterly review with the customer: usage, results and the action plan for the next quarter.', 'partner', 1, 1, TRUE)
    ) AS p(key, name, description, link_kind, link_index, pm_slot, is_closed)
  LOOP
    v_project := md5('crmtree-int-demo-project:' || r.key)::uuid;
    v_pm := v_users[1 + r.pm_slot % v_user_count];
    DELETE FROM projects WHERE id = v_project;

    BEGIN
      INSERT INTO projects (id, tenant_id, key, name, description, status, partner_id, lead_id,
                            created_by, closed_by, closed_at, created_at)
      VALUES (v_project, v_tenant, r.key, r.name, r.description,
              CASE WHEN r.is_closed THEN 'closed' ELSE 'open' END,
              CASE WHEN r.link_kind = 'partner' THEN v_partners[r.link_index] END,
              CASE WHEN r.link_kind = 'lead' THEN v_leads[r.link_index] END,
              v_pm,
              CASE WHEN r.is_closed THEN v_pm END,
              CASE WHEN r.is_closed THEN now() - INTERVAL '25 days' END,
              now() - INTERVAL '45 days');
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE '0314: a project with key % already exists, skipped', r.key;
      CONTINUE;
    END;
    v_created := v_created + 1;

    -- Everyone is in every project; with five or more people the last one
    -- is a controller, who accepts work but is never assigned a task here.
    FOR i IN 1..v_user_count LOOP
      INSERT INTO project_members (project_id, user_id, tenant_id, role, access_level, added_by)
      VALUES (v_project, v_users[i], v_tenant,
              CASE WHEN v_users[i] = v_pm THEN 'pm'
                   WHEN i = v_user_count AND v_user_count >= 5 THEN 'controller'
                   ELSE 'internal_participant' END,
              CASE WHEN v_users[i] <> v_pm AND i = v_user_count AND v_user_count >= 5 THEN 'read' ELSE 'full' END,
              v_pm)
      ON CONFLICT DO NOTHING;
    END LOOP;

    INSERT INTO project_fields (project_id, field_definition_id, tenant_id, is_required, sort_order)
    VALUES (v_project, v_field_ref, v_tenant, FALSE, 0), (v_project, v_field_hrs, v_tenant, FALSE, 1),
           (v_project, v_field_ws,  v_tenant, FALSE, 2), (v_project, v_field_due, v_tenant, FALSE, 3),
           (v_project, v_field_bud, v_tenant, FALSE, 4);
  END LOOP;

  -- ── Tasks ─────────────────────────────────────────────────────────────
  -- start/end are days from today, so the picture stays current whenever
  -- the seed runs: something is always overdue, due today and coming up.
  FOR r IN SELECT * FROM (VALUES
      ('ONB', 1, 0, 'Kick-off meeting with the customer',        'Meeting',   'High',     'Done',        -21, -21, ARRAY[0, 1]),
      ('ONB', 2, 0, 'Collect company data and user list',        'Task',      'Medium',   'Done',        -20, -14, ARRAY[1]),
      ('ONB', 3, 0, 'Configure sales pipeline stages',           'Task',      'High',     'In progress', -10,   2, ARRAY[0]),
      ('ONB', 4, 3, 'Import contacts and open deals',            'Task',      'High',     'In progress',  -5,   0, ARRAY[2]),
      ('ONB', 5, 3, 'Validate imported data with the customer',  'Task',      'Medium',   'To do',         1,   4, ARRAY[0]),
      ('ONB', 6, 0, 'Set up email and calendar integration',     'Task',      'Medium',   'In review',    -7,  -1, ARRAY[1]),
      ('ONB', 7, 0, 'Admin training session',                    'Meeting',   'Medium',   'To do',         6,   6, ARRAY[0, 2]),
      ('ONB', 8, 0, 'Go-live',                                   'Milestone', 'Critical', 'To do',        10,  10, ARRAY[0]),

      ('DMG', 1, 0, 'Export data from the legacy system',        'Task',      'High',     'Done',        -18, -12, ARRAY[1]),
      ('DMG', 2, 0, 'Map legacy fields to CRMtree fields',       'Task',      'High',     'Done',        -12,  -8, ARRAY[0]),
      ('DMG', 3, 0, 'Clean up duplicate companies',              'Task',      'Medium',   'In progress',  -6,   1, ARRAY[2]),
      ('DMG', 4, 0, 'Trial import on the test environment',      'Task',      'High',     'In review',    -4,  -2, ARRAY[0]),
      ('DMG', 5, 4, 'Fix import errors from the trial run',      'Task',      'Critical', 'In progress',  -2,   0, ARRAY[0, 1]),
      ('DMG', 6, 0, 'Final import',                              'Milestone', 'Critical', 'To do',         5,   5, ARRAY[1]),
      ('DMG', 7, 0, 'Sign-off from the customer',                'Meeting',   'Medium',   'To do',         7,   7, ARRAY[0]),

      ('ERP', 1, 0, 'Technical discovery workshop',              'Meeting',   'High',     'Done',        -30, -30, ARRAY[0, 3]),
      ('ERP', 2, 0, 'Define integration scope and data flows',   'Task',      'High',     'Done',        -28, -20, ARRAY[0]),
      ('ERP', 3, 0, 'Build order synchronisation',               'Task',      'High',     'In progress', -15,   3, ARRAY[3]),
      ('ERP', 4, 0, 'Build invoice synchronisation',             'Task',      'Medium',   'To do',         2,  12, ARRAY[3]),
      ('ERP', 5, 0, 'Security review',                           'Task',      'Critical', 'To do',         4,   8, ARRAY[2]),
      ('ERP', 6, 0, 'User acceptance testing',                   'Task',      'High',     'To do',        13,  18, ARRAY[0, 1]),
      ('ERP', 7, 0, 'Production deployment',                     'Milestone', 'Critical', 'To do',        20,  20, ARRAY[0]),

      ('PLT', 1, 0, 'Agree pilot success criteria',              'Meeting',   'High',     'Done',         -9,  -9, ARRAY[0, 2]),
      ('PLT', 2, 0, 'Prepare the pilot environment',             'Task',      'Medium',   'Done',         -8,  -5, ARRAY[2]),
      ('PLT', 3, 0, 'Onboard pilot users',                       'Task',      'Medium',   'In progress',  -4,   1, ARRAY[1]),
      ('PLT', 4, 0, 'Weekly check-in call',                      'Meeting',   'Low',      'In progress',  -3,   0, ARRAY[0]),
      ('PLT', 5, 0, 'Collect feedback from pilot users',         'Task',      'Medium',   'To do',         3,   9, ARRAY[1]),
      ('PLT', 6, 0, 'Pilot summary and commercial proposal',     'Milestone', 'High',     'To do',        12,  12, ARRAY[0]),

      ('RFP', 1, 0, 'Review RFP requirements',                   'Task',      'High',     'Done',         -6,  -4, ARRAY[0]),
      ('RFP', 2, 0, 'Draft solution architecture',               'Task',      'High',     'In review',    -4,  -1, ARRAY[3]),
      ('RFP', 3, 0, 'Prepare pricing model',                     'Task',      'Critical', 'In progress',  -2,   1, ARRAY[0]),
      ('RFP', 4, 0, 'Compile reference customers',               'Task',      'Low',      'To do',         0,   2, ARRAY[1]),
      ('RFP', 5, 0, 'Internal review of the response',           'Meeting',   'Medium',   'To do',         2,   2, ARRAY[0, 1, 3]),
      ('RFP', 6, 0, 'Submit the RFP response',                   'Milestone', 'Critical', 'To do',         4,   4, ARRAY[0]),

      ('QBR', 1, 0, 'Gather usage and sales statistics',         'Task',      'Medium',   'Done',        -40, -35, ARRAY[1]),
      ('QBR', 2, 0, 'Prepare the review presentation',           'Task',      'Medium',   'Done',        -35, -30, ARRAY[0]),
      ('QBR', 3, 0, 'Review meeting with the customer',          'Meeting',   'High',     'Done',        -28, -28, ARRAY[0, 1]),
      ('QBR', 4, 0, 'Send follow-up and action plan',            'Task',      'Low',      'Done',        -27, -25, ARRAY[0])
    ) AS t(key, num, parent_num, name, type_name, priority_name, status_name, start_offset, end_offset, slots)
    ORDER BY key, num
  LOOP
    v_project := md5('crmtree-int-demo-project:' || r.key)::uuid;
    -- Skipped above because its key was taken by a real project.
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM projects WHERE id = v_project AND tenant_id = v_tenant);
    v_task := md5('crmtree-int-demo-task:' || r.key || ':' || r.num)::uuid;

    INSERT INTO project_tasks (id, tenant_id, project_id, task_number, name, type_id, status_id, priority_id,
                               start_date, end_date, parent_task_id, custom_values, created_by, created_at)
    VALUES (
      v_task, v_tenant, v_project, r.num, r.name,
      (SELECT id FROM project_task_types      WHERE tenant_id = v_tenant AND name = r.type_name),
      (SELECT id FROM project_task_statuses   WHERE tenant_id = v_tenant AND name = r.status_name),
      (SELECT id FROM project_task_priorities WHERE tenant_id = v_tenant AND name = r.priority_name),
      CURRENT_DATE + r.start_offset, CURRENT_DATE + r.end_offset,
      CASE WHEN r.parent_num > 0 THEN md5('crmtree-int-demo-task:' || r.key || ':' || r.parent_num)::uuid END,
      jsonb_build_object(
        v_field_ref::text, r.key || '-REF-' || lpad(r.num::text, 3, '0'),
        v_field_hrs::text, 4 + r.num * 3,
        v_field_ws::text,  v_workstream[1 + r.num % 5],
        v_field_due::text, to_char(CURRENT_DATE + r.end_offset + 2, 'YYYY-MM-DD'),
        v_field_bud::text, jsonb_build_object('amount', 1500 * r.num, 'currency', 'EUR')),
      (SELECT created_by FROM projects WHERE id = v_project),
      now() - INTERVAL '45 days' + make_interval(days => r.num));

    FOREACH v_slot IN ARRAY r.slots LOOP
      INSERT INTO project_task_assignees (task_id, user_id, tenant_id)
      VALUES (v_task, v_users[1 + v_slot % v_user_count], v_tenant)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;

  UPDATE projects p
     SET next_task_number = COALESCE((SELECT MAX(task_number) + 1 FROM project_tasks t WHERE t.project_id = p.id), 1)
   WHERE p.tenant_id = v_tenant
     AND p.id IN (SELECT md5('crmtree-int-demo-project:' || k)::uuid
                    FROM unnest(ARRAY['ONB', 'DMG', 'ERP', 'PLT', 'RFP', 'QBR']) AS k);

  -- ── Chats ─────────────────────────────────────────────────────────────
  -- task_num 0 is the project's own chat.
  FOR r IN SELECT * FROM (VALUES
      ('ONB', 0, 1,  96, 'Kick-off done. The customer wants to go live in two weeks, so the pipeline setup is the priority.'),
      ('ONB', 0, 0,  90, 'Agreed. I''ll take the pipeline configuration and the validation with their sales lead.'),
      ('ONB', 0, 2,  50, 'Contact import is running. About 4,200 records, a few hundred without an email address.'),
      ('ONB', 0, 0,  48, 'Please put the incomplete ones on a separate list so the customer can decide what to do with them.'),
      ('ONB', 0, 1,  20, 'Email and calendar integration is ready for review.'),
      ('ONB', 0, 0,   3, 'Thanks. I''ll check it today and confirm the training date with the customer.'),
      ('ONB', 4, 2,  26, 'Import of deals failed on 37 rows because of unknown pipeline stages.'),
      ('ONB', 4, 0,  24, 'Map them to "Qualification" for now, we''ll correct them during validation.'),
      ('ONB', 4, 2,   5, 'Done, re-running the import now.'),

      ('DMG', 0, 1, 120, 'Legacy export is complete. The files are in the shared folder.'),
      ('DMG', 0, 0, 100, 'Field mapping is done. Custom fields from the old system go into the notes.'),
      ('DMG', 0, 2,  70, 'Found about 600 duplicate companies. Merging them before the trial import.'),
      ('DMG', 0, 0,  30, 'Trial import finished with 54 errors, mostly invalid phone numbers.'),
      ('DMG', 0, 1,   6, 'I''ll help with the fixes so we can keep the final import date.'),
      ('DMG', 5, 0,  28, 'The error list is grouped by type. Phone formats first, they are the easy ones.'),
      ('DMG', 5, 1,   7, 'Half of them are fixed. The rest need a decision from the customer.'),

      ('ERP', 0, 0, 200, 'Workshop notes are in the project description. Orders first, invoices second.'),
      ('ERP', 0, 3, 150, 'Order sync is about 60% done. Waiting for API credentials for their test system.'),
      ('ERP', 0, 0, 140, 'I''ll chase the credentials today.'),
      ('ERP', 0, 2,  40, 'The security review can start as soon as order sync is on the test environment.'),
      ('ERP', 0, 3,   8, 'Credentials received. Order sync should be testable by Thursday.'),
      ('ERP', 3, 3,   9, 'First orders are flowing on the test environment. Cancelled orders still need handling.'),
      ('ERP', 3, 0,   4, 'Good progress. Cancelled orders are in scope, please include them before the review.'),

      ('PLT', 0, 2, 180, 'Success criteria agreed: 10 active users and 50 logged activities in three weeks.'),
      ('PLT', 0, 1,  70, '8 of the 10 pilot users have logged in so far.'),
      ('PLT', 0, 0,  60, 'Good. I''ll mention the remaining two on the weekly call.'),
      ('PLT', 0, 2,  10, 'The feedback form is ready to send after the next check-in.'),

      ('RFP', 0, 0, 130, 'Requirements reviewed: 42 points, 5 need clarification from the customer.'),
      ('RFP', 0, 3,  60, 'The architecture draft is ready for review.'),
      ('RFP', 0, 0,  26, 'Pricing model in progress. I need the expected number of users from the customer.'),
      ('RFP', 0, 1,  12, 'I have three reference customers who agreed to be named.'),
      ('RFP', 0, 0,   2, 'Great. Internal review is on Wednesday, submission on Friday.'),
      ('RFP', 3, 0,  20, 'Two options: per-user pricing or a flat fee up to 50 users. I lean towards per-user.'),
      ('RFP', 3, 1,  15, 'Per-user is easier to compare with the other bidders. Let''s go with that.'),

      ('QBR', 0, 1, 700, 'Statistics collected. Usage is up 18% quarter on quarter.'),
      ('QBR', 0, 0, 680, 'Presentation is ready and the meeting is confirmed.'),
      ('QBR', 0, 0, 600, 'Follow-up sent. Closing the project.')
    ) AS m(key, task_num, slot, hours_ago, body)
  LOOP
    v_project := md5('crmtree-int-demo-project:' || r.key)::uuid;
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM projects WHERE id = v_project AND tenant_id = v_tenant);
    INSERT INTO project_messages (tenant_id, project_id, task_id, author_id, body, created_at)
    VALUES (v_tenant, v_project,
            CASE WHEN r.task_num > 0 THEN md5('crmtree-int-demo-task:' || r.key || ':' || r.task_num)::uuid END,
            v_users[1 + r.slot % v_user_count], r.body, now() - make_interval(hours => r.hours_ago));
  END LOOP;

  RAISE NOTICE '0314: seeded % demo projects for brmtree-test1 (% people, % partners, % leads linked)',
    v_created, v_user_count, COALESCE(array_length(v_partners, 1), 0), COALESCE(array_length(v_leads, 1), 0);
END $$;
