const express = require('express');
const router = express.Router();
/*================================================================
 DISCLAIMER
 ================================================================*/
router.get('/disclaimer', (req, res) => {
    let data = {}
    if (global.config.login.disclaimer) data["disclaimer"] = global.config.login.disclaimer;
    if (global.config.login.github_url) data["github_url"] = global.config.login.github_url;
    if (global.config.login.docker_url) data["docker_url"] = global.config.login.docker_url;
    res.json(data);
})


module.exports = router;