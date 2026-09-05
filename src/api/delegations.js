import express from "express";
import { acceptDelegationInvite, createDelegationInvite, getInvitePreview, listDelegates, listPrincipals, revokeDelegation, updateDelegation } from "../core/delegations.js";

const router = express.Router();
function fail(res, error) { res.status(error.statusCode || 400).json({ error: String(error.message || error) }); }

router.post("/delegations/invites", (req, res) => {
  try { res.json({ ok: true, invite: createDelegationInvite(req.user.id, req.body) }); } catch (error) { fail(res, error); }
});
router.get("/delegations/invites/:token", (req, res) => {
  const invite = getInvitePreview(req.params.token);
  if (!invite) return res.status(404).json({ error: "邀请不存在、已使用或已过期" });
  res.json({ ok: true, invite });
});
router.post("/delegations/invites/:token/accept", (req, res) => {
  try { res.json({ ok: true, delegation: acceptDelegationInvite(req.params.token, req.body?.password, req.user.id) }); } catch (error) { fail(res, error); }
});
router.get("/delegations/delegates", (req, res) => res.json({ ok: true, delegations: listDelegates(req.user.id) }));
router.get("/delegations/principals", (req, res) => res.json({ ok: true, delegations: listPrincipals(req.user.id) }));
router.put("/delegations/:id", (req, res) => {
  try {
    const delegation = updateDelegation(req.params.id, req.user.id, req.body);
    if (!delegation) return res.status(404).json({ error: "授权不存在" });
    res.json({ ok: true, delegation });
  } catch (error) { fail(res, error); }
});
router.delete("/delegations/:id", (req, res) => {
  const ok = revokeDelegation(req.params.id, req.user.id);
  if (!ok) return res.status(404).json({ error: "授权不存在" });
  res.json({ ok: true });
});

export default router;
