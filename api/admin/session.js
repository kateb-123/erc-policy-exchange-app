'use strict';
// /api/admin/session  GET: is this browser signed in?
// The work is in api/_admin.js.
const { handleSession } = require('../_admin');

module.exports = (req, res) => handleSession(req, res);
