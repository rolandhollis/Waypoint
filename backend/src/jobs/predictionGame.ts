import cron from "node-cron";
import { config } from "../config.js";
import { generateDailyPredictionQuestions } from "../routes/predictionGame.js";

/** 5:30am Central — publish the daily question before most users log in. */
export function startPredictionGameCron() {
  const tz = config.reportingTimezone;
  cron.schedule("30 5 * * *", () => {
    generateDailyPredictionQuestions().catch((err) => {
      console.error("[cron] prediction game generate failed:", err);
    });
  }, { timezone: tz });
  console.log(`[cron] prediction game scheduled daily at 5:30am in ${tz}`);
}
