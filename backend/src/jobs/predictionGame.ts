import cron from "node-cron";
import { config } from "../config.js";
import { generateDailyPredictionQuestions } from "../routes/predictionGame.js";

/** 2:00am Central — generate the daily question overnight before voting opens at 9am. */
export function startPredictionGameCron() {
  const tz = config.reportingTimezone;
  cron.schedule("0 2 * * *", () => {
    generateDailyPredictionQuestions().catch((err) => {
      console.error("[cron] prediction game generate failed:", err);
    });
  }, { timezone: tz });
  console.log(`[cron] prediction game scheduled daily at 2:00am in ${tz}`);
}
