// @flow

import amqplib from 'amqplib'
import Bluebird from 'bluebird'

import { connect } from './connections'

export type Options = {
  connectionString: string,
  prefix?: string,
}

type Job = {}
type JobOpts = {}

type ProcessFnPromise = (job: Job) => Promise<any>
type ProcessFnCallback = (job: Job, done: Function) => any
type ProcessFn = ProcessFnPromise | ProcessFnCallback

class Queue {
  _options: Options
  _name: string
  _conn: any // TODO types
  _publishChan: any // TODO types
  _consumeChans: { [key: string]: any } = {} // TODO types
  _queuesExist: { [key: string]: boolean } = {}

  constructor(name: string, options?: Options | string) {
    if (typeof options === 'string') {
      options = {
        connectionString: options,
      }
    }

    if (!options) {
      throw new Error(`options are required`)
    }

    this._options = options
    this._name = name
  }

  async _ensureConnection() {
    if (!this._conn) {
      this._conn = await connect(this._options.connectionString)
    }

    return this._conn
  }

  async _ensurePublishChannelOpen() {
    if (!this._publishChan) {
      this._publishChan = (await this._ensureConnection()).createChannel()
    }

    return this._publishChan
  }

  async _ensureConsumeChannelOpen(queue: string) {
    if (!this._consumeChans[queue]) {
      this._consumeChans[
        queue
      ] = (await this._ensureConnection()).createChannel()
    }

    return this._consumeChans[queue]
  }

  async _ensureQueueExists(queue: string, channel: any) {
    if (!this._queuesExist[queue]) {
      await channel.assertQueue(queue)
      this._queuesExist[queue] = true
    }
  }

  _getQueueName(name: string) {
    return (this._options.prefix || 'bull') + '-' + name
  }

  _getPublishOptions() {
    return {
      persistent: true, // TODO
    }
  }

  async process(name?: string, concurrency?: number, handler: ProcessFn) {
    switch (arguments.length) {
      case 1:
        // $FlowFixMe
        handler = name
        concurrency = 1
        name = undefined
        break
      case 2: // (string, function) or (string, string) or (number, function) or (number, string)
        // $FlowFixMe
        handler = concurrency
        if (typeof name === 'string') {
          concurrency = 1
        } else {
          concurrency = name
          name = undefined
        }
        break
    }

    const queue = this._getQueueName(name || this._name)
    const chan = await this._ensureConsumeChannelOpen(queue)
    await chan.prefetch(concurrency)

    const promiseHandler: ProcessFnPromise =
      // $FlowFixMe
      handler.length === 1
        ? handler
        : function promiseHandler(job) {
            return new Bluebird((resolve, reject) => {
              // $FlowFixMe
              handler(job, (err, result) => {
                if (err) {
                  return reject(err)
                }

                return resolve(result)
              })
            })
          }

    await this._ensureQueueExists(queue, chan)

    chan.consume(queue, async (msg) => {
      try {
        const data = JSON.parse(msg.content.toString())
        const job = {
          data,
        }
        const result = await promiseHandler(job)

        // see if we need to reply
        if (
          typeof result !== 'undefined' &&
          typeof msg.properties === 'object' &&
          typeof msg.properties.replyTo !== 'undefined' &&
          typeof msg.properties.correlationId !== 'undefined'
        ) {
          chan.sendToQueue(
            msg.properties.replyTo,
            new Buffer(JSON.stringify(result)),
            {
              correlationId: msg.properties.correlationId,
            },
          )
        }

        chan.ack(msg)
      } catch (err) {
        chan.nack(msg, false, false)
      }
    })
  }

  async add(name?: string, data: any, opts?: JobOpts) {
    if (typeof name !== 'string') {
      opts = data
      data = name
      name = undefined
    }

    const chan = await this._ensurePublishChannelOpen()
    const queue = this._getQueueName(name || this._name)
    await this._ensureQueueExists(queue, chan)
    chan.sendToQueue(
      queue,
      new Buffer(JSON.stringify(data)),
      this._getPublishOptions(),
    )
  }

  pause() {
    throw new Error(`Not implemented yet`)
  }

  resume() {
    throw new Error(`Not implemented yet`)
  }

  count() {
    throw new Error(`Not implemented yet`)
  }

  empty() {
    throw new Error(`Not implemented yet`)
  }
}
