-- Restore super admin account: set temp password + ensure flags are correct.
-- Temp password: CRMtree2026!  (must_change_password = true forces change on next login)
UPDATE users
SET
  is_admin             = true,
  is_super_admin       = true,
  is_active            = true,
  password_hash        = '$2a$12$hQFNCZOyGnyWo.46fwIQT.P3gZ8h3knv8zSg/IRUOTaNFhpN3./Bi',
  must_change_password = true
WHERE email = 'adam.manka@worktrips.com';
