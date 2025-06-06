import { Thread, ThreadType } from "../threads"
import { automationQueue } from "./bullboard"
import { updateEntityMetadata } from "../utilities"
import { context, db as dbCore, utils } from "@budibase/backend-core"
import { getAutomationMetadataParams } from "../db/utils"
import { quotas } from "@budibase/pro"
import {
  Automation,
  AutomationJob,
  CronTriggerInputs,
  isCronTrigger,
  MetadataType,
} from "@budibase/types"
import { automationsEnabled } from "../features"
import { helpers, REBOOT_CRON } from "@budibase/shared-core"
import tracer from "dd-trace"
import { JobId } from "bull"

let Runner: Thread
if (automationsEnabled()) {
  Runner = new Thread(ThreadType.AUTOMATION)
}

function loggingArgs(job: AutomationJob) {
  return [
    {
      _logKey: "automation",
      trigger: job.data.automation.definition.trigger.event,
    },
    {
      _logKey: "bull",
      jobId: job.id,
    },
  ]
}

export async function processEvent(job: AutomationJob) {
  return tracer.trace("processEvent", async span => {
    const appId = job.data.event.appId!
    const automationId = job.data.automation._id!

    span.addTags({
      appId,
      automationId,
      job: {
        id: job.id,
        name: job.name,
        attemptsMade: job.attemptsMade,
        attempts: job.opts.attempts,
        priority: job.opts.priority,
        delay: job.opts.delay,
        repeat: job.opts.repeat,
        backoff: job.opts.backoff,
        lifo: job.opts.lifo,
        timeout: job.opts.timeout,
        jobId: job.opts.jobId,
        removeOnComplete: job.opts.removeOnComplete,
        removeOnFail: job.opts.removeOnFail,
        stackTraceLimit: job.opts.stackTraceLimit,
        preventParsingData: job.opts.preventParsingData,
      },
    })

    const task = async () => {
      try {
        return await tracer.trace("task", async () => {
          const trigger = job.data.automation
            ? job.data.automation.definition.trigger
            : null
          const isCron = trigger && isCronTrigger(trigger)
          if (isCron && !job.data.event.timestamp) {
            // Requires the timestamp at run time
            job.data.event.timestamp = Date.now()
          }
          // need to actually await these so that an error can be captured properly
          console.log("automation running", ...loggingArgs(job))

          const runFn = () => Runner.run(job)
          const result = await quotas.addAutomation(runFn, { automationId })
          console.log("automation completed", ...loggingArgs(job))
          return result
        })
      } catch (err) {
        span.addTags({ error: true })
        console.error(`automation was unable to run`, err, ...loggingArgs(job))
        return { err }
      }
    }

    return await context.doInAutomationContext({ appId, automationId, task })
  })
}

export async function updateTestHistory(
  appId: any,
  automation: any,
  history: any
) {
  return updateEntityMetadata(
    MetadataType.AUTOMATION_TEST_HISTORY,
    automation._id,
    (metadata: any) => {
      if (metadata && Array.isArray(metadata.history)) {
        metadata.history.push(history)
      } else {
        metadata = {
          history: [history],
        }
      }
      return metadata
    }
  )
}

// end the repetition and the job itself
export async function disableAllCrons(appId: any) {
  const promises = []
  const jobs = await automationQueue.getBullQueue().getRepeatableJobs()
  for (let job of jobs) {
    if (job.key.includes(`${appId}_cron`)) {
      promises.push(
        automationQueue.getBullQueue().removeRepeatableByKey(job.key)
      )
      if (job.id) {
        promises.push(automationQueue.getBullQueue().removeJobs(job.id))
      }
    }
  }
  const results = await Promise.all(promises)
  return { count: results.length / 2 }
}

export async function disableCronById(jobId: JobId) {
  const jobs = await automationQueue.getBullQueue().getRepeatableJobs()
  for (const job of jobs) {
    if (job.id === jobId) {
      await automationQueue.getBullQueue().removeRepeatableByKey(job.key)
    }
  }
  console.log(`jobId=${jobId} disabled`)
}

export async function clearMetadata() {
  const db = context.getProdAppDB()
  const automationMetadata = (
    await db.allDocs(
      getAutomationMetadataParams({
        include_docs: true,
      })
    )
  ).rows.map((row: any) => row.doc)
  for (let metadata of automationMetadata) {
    metadata._deleted = true
  }
  await db.bulkDocs(automationMetadata)
}

export function isRebootTrigger(auto: Automation) {
  const trigger = auto ? auto.definition.trigger : null
  const isCron = trigger && isCronTrigger(trigger)
  if (!isCron) {
    return false
  }
  const inputs = trigger?.inputs as CronTriggerInputs
  return inputs.cron === REBOOT_CRON
}

/**
 * This function handles checking of any cron jobs that need to be enabled/updated.
 * @param appId The ID of the app in which we are checking for webhooks
 * @param automation The automation object to be updated.
 */
export async function enableCronTrigger(appId: any, automation: Automation) {
  const trigger = automation ? automation.definition.trigger : null
  let enabled = false

  // need to create cron job
  if (
    trigger &&
    isCronTrigger(trigger) &&
    !isRebootTrigger(automation) &&
    !automation.disabled
  ) {
    const inputs = trigger.inputs as CronTriggerInputs
    const cronExp = inputs.cron
    const validation = helpers.cron.validate(cronExp)
    if (!validation.valid) {
      throw new Error(
        `Invalid automation CRON "${cronExp}" - ${validation.err.join(", ")}`
      )
    }
    // make a job id rather than letting Bull decide, makes it easier to handle on way out
    const jobId = `${appId}_cron_${utils.newid()}`
    const job = await automationQueue.add(
      {
        automation,
        event: { appId },
      },
      { repeat: { cron: cronExp }, jobId }
    )
    // Assign cron job ID from bull so we can remove it later if the cron trigger is removed
    trigger.cronJobId = job.id.toString()
    // can't use getAppDB here as this is likely to be called from dev app,
    // but this call could be for dev app or prod app, need to just use what
    // was passed in
    await dbCore.doWithDB(appId, async db => {
      const response = await db.put(automation)
      automation._id = response.id
      automation._rev = response.rev
    })
    enabled = true
  }
  return { enabled, automation }
}

/**
 * When removing an app/unpublishing it need to make sure automations are cleaned up (cron).
 * @param appId the app that is being removed.
 * @return clean is complete if this succeeds.
 */
export async function cleanupAutomations(appId: any) {
  await disableAllCrons(appId)
}
