'use strict';
// /api/admin/save  POST: one change (edit, delete, restore, pin, unpin, hide, unhide, hero, card, uncard, picture), committed to GitHub.
// The work is in api/_admin.js.
const { handleSave } = require('../_admin');

module.exports = (req, res) => handleSave(req, res);
