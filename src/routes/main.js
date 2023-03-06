/*================================================================
LOGIN:
Generate the generic or unique login page based on the URL params
================================================================*/
const express = require('express');
const router = express.Router();

/*================================================================
ROUTES
================================================================*/
// when the user load the unique login page
router.get("/", (_req, res) => {
    res.sendFile(global.appPath + '/views/index.html');
});

module.exports = router;