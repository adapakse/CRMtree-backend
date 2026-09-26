'use strict';
// utils/crmtreeBlog.js — the one tenant whose articles are served on the
// public crmtree.pl blog. It's the production "comparme" tenant (slug:
// comparme), CRMtree's own working CRM tenant, not a client. Client tenants
// publish to their own WordPress sites instead (wordpressService).

const CRMTREE_BLOG_TENANT_ID = '1e610ab7-1f34-427f-bd05-b4094b8077c7';
const CRMTREE_BLOG_SITE_URL = 'https://crmtree.pl';

module.exports = { CRMTREE_BLOG_TENANT_ID, CRMTREE_BLOG_SITE_URL };
