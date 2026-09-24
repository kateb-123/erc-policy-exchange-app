'use strict';
// /api/admin/save  POST: one change (edit, delete, pin, unpin, hide, unhide, card, uncard), committed to GitHub.
// The work is in api/_admin.js.
const { handleSave } = require('../_admin');

module.exports = (req, res) => handleSave(req, res);
