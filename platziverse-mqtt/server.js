'use strict'

const debug = require('debug')('platziverse:mqtt')
const mosca = require('mosca')
const redis = require('redis')
const chalk = require('chalk')
const db = require('platziverse-db')
const {parsePayload} = require('./utils')

const backend = {
  type: 'redis',
  redis,
  return_buffers: true
}

// configuracion de servidor de mosca
const settings = {
  port: 1883,
  backend
}

const config = {
  database: process.env.DB_NAME || 'platziverse',
  username: process.env.DB_USER || 'platzi',
  password: process.env.DB_PASS || 'platzi',
  host: process.env.DB_HOST || 'localhost',
  dialect: 'postgres',
  logging: s => debug(s)
}

const server = new mosca.Server(settings)
const clients = new Map()

let Agent, Metric

server.on('clientConnected', client => {
  debug(`Client Connected: ${client.id}`)
  clients.set(client.id, null)
})

server.on('clientDisconnected', async (client) => {
  debug(`Client Disconnected: ${client.id}`)
  const agent = clients.get(client.id)

  if(agent){
      //Mark agent as discconeted
      agent.connected = false

      try{
        await Agent.createOrUpdate(agent)
      }
      catch(e){
        return handleError(e)
      }

      //Delete Agent form Clients list
      clients.delete(client.id)

      server.publish({
          topic: 'agent/disconnected',
          payload: JSON.stringify({
              uuid: agent.uuid
          })
      })
      debug(`Client (${client.id}) associated to Agent (${agent.uuid}) marked as discconected`)
  }
})

server.on('published', async (packet, client) => {
  debug(`Received: ${packet.topic}`)

  switch (packet.topic) {
    case 'agent/connected':
    case 'agent/disconnected':
      debug(`Payload: ${packet.payload}`)
      break
    case 'agent/message':
      debug(`Payload: ${packet.payload}`)
      const payload = parsePayload(packet.payload)

      if (payload) {
        payload.agent.connected = true
        let agent
        try {
          agent = await Agent.createOrUpdate(payload.agent)
        } catch (e) {
          return handleError(e)
        }

        debug(`Agent ${agent.uuid} saved`)

        // Notificar que el agente fue conectado
        if (!clients.get(client.id)) {
          clients.set(client.id, agent)
          server.publish({
            topic: 'agent/connected',
            payload: JSON.stringify({
              agent: {
                uuid: agent.uuid,
                name: agent.name,
                hostname: agent.hostname,
                pid: agent.pid,
                connected: agent.connected
              }
            })
          })
        }

        //Store Metric
        for (let metric of payload.metrics){
            let m
            try{
                m = await Metric.create(agent.uuid, metric)
            }   
            catch(e){
                return handleError(e)
            }

            debug(`Metric ${m.id} saved on agent ${agent.uuid}`)
        }
        
      }
      break
  }

  debug(`Payload: ${packet.payload}`)
})

server.on('ready', async () => {
  const services = await db(config).catch(handleFatalError)

  Agent = services.Agent
  Metric = services.Metric

  console.log(`${chalk.green('[platziverse-mqtt]')} server is running`)
})

server.on('error', handleFatalError)

function handleFatalError (err) {
  console.log(`${chalk.red('[fatal error]')} ${err.message}`)
  console.log(err.stack)
  process.exit(1)
}

function handleError (err) {
  console.log(`${chalk.red('[fatal error]')} ${err.message}`)
  console.log(err.stack)
}

process.on('uncaughtException', handleFatalError)
process.on('unhandleRejection', handleFatalError)
