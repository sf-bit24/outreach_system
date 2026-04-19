import { Router, type IRouter } from "express";
import healthRouter from "./health";
import leadsRouter from "./leads";
import campaignsRouter from "./campaigns";
import emailsRouter from "./emails";
import dashboardRouter from "./dashboard";
import settingsRouter from "./settings";
import complianceRouter from "./compliance";

const router: IRouter = Router();

router.use(healthRouter);
router.use(leadsRouter);
router.use(campaignsRouter);
router.use(emailsRouter);
router.use(dashboardRouter);
router.use(settingsRouter);
router.use(complianceRouter);

export default router;
