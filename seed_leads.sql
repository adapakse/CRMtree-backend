DO $$
DECLARE
  uid UUID := '4e2add6d-1d0c-47b4-8bcc-4172476b0e3a';
BEGIN

INSERT INTO crm_leads
  (company, contact_name, contact_title, email, phone, source, stage,
   value_pln, probability, close_date, industry, assigned_to, created_by,
   tags, notes, hot, nip, website, online_pct, first_contact_date, created_at)
VALUES
  ('TechCorp Polska Sp. z o.o.','Marek Kowalski','CEO','m.kowalski@techcorp.pl','600100200','cold_call','qualification',120000,40,'2026-06-30','IT',uid,uid,'{}','Zainteresowany pakietem Enterprise',false,'5270000001','techcorp.pl',60,'2026-01-10', NOW() - INTERVAL '90 days'),
  ('LogiTrans S.A.','Anna Wisniewska','CFO','a.wisniewska@logitrans.pl','601200300','referral','presentation',250000,60,'2026-05-31','Transport',uid,uid,'{}','Po prezentacji poprosila o oferte',true,'5270000002','logitrans.pl',20,'2026-01-15', NOW() - INTERVAL '85 days'),
  ('MediGroup Sp. z o.o.','Piotr Nowak','Director','p.nowak@medigroup.pl','602300400','website','offer',80000,70,'2026-04-30','Healthcare',uid,uid,'{}','Negocjacje cenowe w toku',false,'5270000003','medigroup.pl',50,'2026-01-20', NOW() - INTERVAL '80 days'),
  ('RetailMax Sp. z o.o.','Katarzyna Zielinska','Manager','k.zielinska@retailmax.pl','603400500','linkedin','new',45000,20,'2026-07-31','Retail',uid,uid,'{}','Wstepny kontakt, czeka na brief',false,'5270000004','retailmax.pl',80,'2026-02-01', NOW() - INTERVAL '75 days'),
  ('FinPro S.A.','Tomasz Lewandowski','VP','t.lewandowski@finpro.pl','604500600','conference','negotiation',320000,80,'2026-04-15','Finance',uid,uid,'{}','Finalny etap negocjacji',true,'5270000005','finpro.pl',30,'2026-01-05', NOW() - INTERVAL '70 days'),
  ('EduTech Sp. z o.o.','Magdalena Wojcik','Owner','m.wojcik@edutech.pl','605600700','email','qualification',55000,35,'2026-06-15','Education',uid,uid,'{}','Branza edukacyjna - sezon wakacyjny kluczowy',false,'5270000006','edutech.pl',90,'2026-02-10', NOW() - INTERVAL '65 days'),
  ('BuildCo S.A.','Lukasz Dabrowski','CEO','l.dabrowski@buildco.pl','606700800','referral','presentation',190000,55,'2026-05-15','Manufacturing',uid,uid,'{}','Referencja od EuroTravel',false,'5270000007','buildco.pl',10,'2026-02-15', NOW() - INTERVAL '60 days'),
  ('LegalFirst Sp. z o.o.','Natalia Krawczyk','Specialist','n.krawczyk@legalfirst.pl','607800900','cold_call','new',30000,15,'2026-08-31','Legal',uid,uid,'{}','Mala kancelaria, budzet ograniczony',false,'5270000008','legalfirst.pl',40,'2026-02-20', NOW() - INTERVAL '55 days'),
  ('GlobalShip S.A.','Robert Wojciechowski','COO','r.wojciechowski@globalship.pl','608900100','linkedin','offer',410000,75,'2026-04-30','Transport',uid,uid,'{}','Duzy kontrakt, wymaga akceptacji zarzadu',true,'5270000009','globalship.pl',10,'2026-01-25', NOW() - INTERVAL '50 days'),
  ('SmartRetail Sp. z o.o.','Aleksandra Kaminska','Manager','a.kaminska@smartretail.pl','609100200','website','qualification',70000,45,'2026-06-30','Retail',uid,uid,'{}','Siec sklepow ogolnopolska',false,'5270000010','smartretail.pl',70,'2026-03-01', NOW() - INTERVAL '45 days'),
  ('DataSoft Sp. z o.o.','Michal Wisniewski','CTO','m.wisniewski@datasoft.pl','610200300','conference','closed_won',150000,100,'2026-03-15','IT',uid,uid,'{}','Kontrakt podpisany',false,'5270000011','datasoft.pl',100,'2025-12-01', NOW() - INTERVAL '120 days'),
  ('AeroLogistics S.A.','Barbara Adamczyk','Director','b.adamczyk@aerolog.pl','611300400','referral','negotiation',280000,70,'2026-05-01','Transport',uid,uid,'{}','Ostatnia runda negocjacji budzetowych',true,'5270000012','aerolog.pl',20,'2026-01-30', NOW() - INTERVAL '40 days'),
  ('GreenEnergy Sp. z o.o.','Stanislaw Majewski','CEO','s.majewski@greenenergy.pl','612400500','cold_call','new',90000,25,'2026-09-30','Manufacturing',uid,uid,'{}','Sektor OZE, perspektywiczny',false,'5270000013','greenenergy.pl',30,'2026-03-10', NOW() - INTERVAL '35 days'),
  ('MediaHouse S.A.','Joanna Nowakowska','VP','j.nowakowska@mediahouse.pl','613500600','linkedin','presentation',130000,50,'2026-05-31','Other',uid,uid,'{}','Dom mediowy, duze podroze sluzbowe',false,'5270000014','mediahouse.pl',20,'2026-02-25', NOW() - INTERVAL '30 days'),
  ('HealthPlus Sp. z o.o.','Krzysztof Pawlak','CFO','k.pawlak@healthplus.pl','614600700','website','qualification',60000,40,'2026-07-15','Healthcare',uid,uid,'{}','Siec klinik prywatnych',false,'5270000015','healthplus.pl',40,'2026-03-05', NOW() - INTERVAL '25 days'),
  ('TravelFirst S.A.','Monika Grabowska','Owner','m.grabowska@travelfirst.pl','615700800','referral','offer',220000,65,'2026-05-15','Tourism',uid,uid,'{}','Agencja turystyczna premium',true,'5270000016','travelfirst.pl',60,'2026-02-28', NOW() - INTERVAL '20 days'),
  ('AutoParts Sp. z o.o.','Wojciech Kozlowski','Manager','w.kozlowski@autoparts.pl','616800900','conference','new',35000,20,'2026-08-31','Manufacturing',uid,uid,'{}','Dystrybutor czesci samochodowych',false,'5270000017','autoparts.pl',10,'2026-03-15', NOW() - INTERVAL '15 days'),
  ('InsureTech S.A.','Dorota Wrobel','Specialist','d.wrobel@insuretech.pl','617900100','email','closed_lost',75000,0,'2026-02-28','Finance',uid,uid,'{}','Przegrana z konkurencja cenowa',false,'5270000018','insuretech.pl',50,'2025-11-15', NOW() - INTERVAL '130 days'),
  ('PharmaCo Sp. z o.o.','Adam Michalski','CEO','a.michalski@pharmaco.pl','618100200','cold_call','qualification',180000,45,'2026-06-30','Healthcare',uid,uid,'{}','Firma farmaceutyczna, konferencje miedzynarodowe',true,'5270000019','pharmaco.pl',20,'2026-03-20', NOW() - INTERVAL '10 days'),
  ('CloudSys S.A.','Ewa Jankowska','CTO','e.jankowska@cloudsys.pl','619200300','linkedin','presentation',95000,55,'2026-05-31','IT',uid,uid,'{}','Startup SaaS, szybki wzrost',false,'5270000020','cloudsys.pl',100,'2026-03-25', NOW() - INTERVAL '5 days'),
  ('FoodGlobal Sp. z o.o.','Rafal Zawadzki','Director','r.zawadzki@foodglobal.pl','620300400','referral','offer',310000,70,'2026-04-30','Other',uid,uid,'{}','Miedzynarodowy dystrybutor zywnosci',true,'5270000021','foodglobal.pl',30,'2026-03-01', NOW() - INTERVAL '7 days'),
  ('SportsPro S.A.','Karolina Mazur','VP','k.mazur@sportspro.pl','621400500','website','negotiation',145000,75,'2026-04-20','Other',uid,uid,'{}','Liga zawodowa i transfery sportowe',false,'5270000022','sportspro.pl',40,'2026-02-10', NOW() - INTERVAL '12 days'),
  ('PrintMaster Sp. z o.o.','Zbigniew Krol','Owner','z.krol@printmaster.pl','622500600','conference','new',28000,15,'2026-09-15','Manufacturing',uid,uid,'{}','Drukarnia wielkoformatowa',false,'5270000023','printmaster.pl',10,'2026-03-28', NOW() - INTERVAL '3 days'),
  ('HotelChain S.A.','Paulina Stepien','CFO','p.stepien@hotelchain.pl','623600700','referral','qualification',380000,50,'2026-06-15','Tourism',uid,uid,'{}','Siec 12 hoteli w Polsce',true,'5270000024','hotelchain.pl',30,'2026-03-22', NOW() - INTERVAL '8 days'),
  ('LogiSoft Sp. z o.o.','Marcin Sikora','Manager','m.sikora@logisoft.pl','624700800','email','presentation',112000,60,'2026-05-20','IT',uid,uid,'{}','Oprogramowanie dla logistyki',false,'5270000025','logisoft.pl',80,'2026-03-18', NOW() - INTERVAL '6 days');

END $$;

SELECT stage, COUNT(*) FROM crm_leads GROUP BY stage ORDER BY stage;
