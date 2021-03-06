/* eslint camelcase: 0 */
import _ from 'underscore'
import Joi from 'joi'
import atob from 'atob';
import nodemailer from 'nodemailer';
import {CommonProviderSettings} from 'imap-provider-settings';
import {INSECURE_TLS_OPTIONS, SECURE_TLS_OPTIONS} from './tls-utils';
import IMAPConnection from './imap-connection'
import {NylasError, RetryableError} from './errors'
import {convertSmtpError} from './smtp-errors'

const {GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET} = process.env;

const imapSmtpSettings = Joi.object().keys({
  imap_host: [Joi.string().ip().required(), Joi.string().hostname().required()],
  imap_port: Joi.number().integer().required(),
  imap_username: Joi.string().required(),
  imap_password: Joi.string().required(),
  smtp_host: [Joi.string().ip().required(), Joi.string().hostname().required()],
  smtp_port: Joi.number().integer().required(),
  smtp_username: Joi.string().required(),
  smtp_password: Joi.string().required(),
  // new options - not required() for backcompat
  smtp_security: Joi.string(),
  imap_security: Joi.string(),
  imap_allow_insecure_ssl: Joi.boolean(),
  smtp_allow_insecure_ssl: Joi.boolean(),
  // TODO: deprecated options - eventually remove!
  smtp_custom_config: Joi.object(),
  ssl_required: Joi.boolean(),
}).required();

const resolvedGmailSettings = Joi.object().keys({
  xoauth2: Joi.string().required(),
  expiry_date: Joi.number().integer().required(),
}).required();

const office365Settings = Joi.object().keys({
  name: Joi.string().required(),
  type: Joi.string().valid('office365').required(),
  email: Joi.string().required(),
  password: Joi.string().required(),
  username: Joi.string().required(),
}).required();

export const SUPPORTED_PROVIDERS = new Set(
  ['gmail', 'office365', 'imap', 'icloud', 'yahoo', 'fastmail']
);

export function generateXOAuth2Token(username, accessToken) {
  // See https://developers.google.com/gmail/xoauth2_protocol
  // for more details.
  const s = `user=${username}\x01auth=Bearer ${accessToken}\x01\x01`
  return new Buffer(s).toString('base64');
}

export function googleSettings(googleToken, email) {
  const connectionSettings = Object.assign({
    imap_username: email,
    smtp_username: email,
  }, CommonProviderSettings.gmail);
  const connectionCredentials = {
    expiry_date: Math.floor(googleToken.expiry_date / 1000),
  };
  if (GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET) {
    // cloud-only credentials
    connectionCredentials.client_id = GMAIL_CLIENT_ID;
    connectionCredentials.client_secret = GMAIL_CLIENT_SECRET;
    connectionCredentials.access_token = googleToken.access_token;
    connectionCredentials.refresh_token = googleToken.refresh_token;
  }
  if (googleToken.xoauth2) {
    connectionCredentials.xoauth2 = googleToken.xoauth2;
  } else {
    connectionCredentials.xoauth2 = generateXOAuth2Token(email, googleToken.access_token)
  }
  return {connectionSettings, connectionCredentials}
}

export function credentialsForProvider({provider, settings, email}) {
  if (provider === "gmail") {
    const {connectionSettings, connectionCredentials} = googleSettings(settings, email)
    return {connectionSettings, connectionCredentials}
  } else if (provider === "office365") {
    const connectionSettings = CommonProviderSettings[provider];

    const connectionCredentials = {
      imap_username: email,
      imap_password: settings.password || settings.imap_password,
      smtp_username: email,
      smtp_password: settings.password || settings.smtp_password,
    }
    return {connectionSettings, connectionCredentials}
  } else if (SUPPORTED_PROVIDERS.has(provider)) {
    const connectionSettings = _.pick(settings, [
      'imap_host', 'imap_port', 'imap_security',
      'smtp_host', 'smtp_port', 'smtp_security',
      'smtp_allow_insecure_ssl',
      'imap_allow_insecure_ssl',
    ]);
    // BACKCOMPAT ONLY - remove eventually & make _security params required!
    if (!connectionSettings.imap_security) {
      switch (connectionSettings.imap_port) {
        case 993:
          connectionSettings.imap_security = "SSL / TLS";
          break;
        default:
          connectionSettings.imap_security = "none";
          break;
      }
    }
    if (!connectionSettings.smtp_security) {
      switch (connectionSettings.smtp_security) {
        case 465:
          connectionSettings.smtp_security = "SSL / TLS";
          break;
        default:
          connectionSettings.smtp_security = 'STARTTLS';
          break;
      }
    }
    // END BACKCOMPAT
    const connectionCredentials = _.pick(settings, [
      'imap_username', 'imap_password',
      'smtp_username', 'smtp_password',
    ]);
    return {connectionSettings, connectionCredentials}
  }
  throw new Error(`Invalid provider: ${provider}`)
}

function bearerToken(xoauth2) {
  // We have to unpack the access token from the entire XOAuth2
  // token because it is re-packed during the SMTP connection login.
  // https://github.com/nodemailer/smtp-connection/blob/master/lib/smtp-connection.js#L1418
  const bearer = "Bearer ";
  const decoded = atob(xoauth2);
  const tokenIndex = decoded.indexOf(bearer) + bearer.length;
  return decoded.substring(tokenIndex, decoded.length - 2);
}

export function smtpConfigFromSettings(provider, connectionSettings, connectionCredentials) {
  const {smtp_host, smtp_port, smtp_security, smtp_allow_insecure_ssl} = connectionSettings;
  const config = {
    host: smtp_host,
    port: smtp_port,
    secure: smtp_security === 'SSL / TLS',
  };
  if (smtp_security === 'STARTTLS') {
    config.requireTLS = true;
  }
  if (smtp_allow_insecure_ssl) {
    config.tls = INSECURE_TLS_OPTIONS;
  } else {
    config.tls = SECURE_TLS_OPTIONS;
  }

  if (provider === 'gmail') {
    const {xoauth2} = connectionCredentials;
    if (!xoauth2) {
      throw new Error("Missing XOAuth2 Token")
    }

    const token = bearerToken(xoauth2);

    config.auth = { user: connectionSettings.smtp_username, xoauth2: token }
  } else if (SUPPORTED_PROVIDERS.has(provider)) {
    const {smtp_username, smtp_password} = connectionCredentials
    config.auth = { user: smtp_username, pass: smtp_password}
  } else {
    throw new Error(`${provider} not yet supported`)
  }

  return config;
}

export function imapAuthRouteConfig() {
  return {
    description: 'Authenticates a new account.',
    tags: ['accounts'],
    auth: false,
    validate: {
      payload: {
        email: Joi.string().email().required(),
        name: Joi.string().required(),
        provider: Joi.string().valid(...SUPPORTED_PROVIDERS).required(),
        settings: Joi.alternatives().try(imapSmtpSettings, office365Settings, resolvedGmailSettings),
      },
    },
  }
}

export function imapAuthHandler(upsertAccount) {
  const MAX_RETRIES = 2
  const authHandler = (request, reply, retryNum = 0) => {
    const dbStub = {};
    const {email, provider, name} = request.payload;

    const connectionChecks = [];
    const {connectionSettings, connectionCredentials} = credentialsForProvider(request.payload)

    const smtpConfig = smtpConfigFromSettings(provider, connectionSettings, connectionCredentials);
    const smtpTransport = nodemailer.createTransport(Object.assign({
      connectionTimeout: 30000,
    }, smtpConfig));

    // All IMAP accounts require a valid SMTP server for sending, and we never
    // want to allow folks to connect accounts and find out later that they
    // entered the wrong SMTP credentials. So verify here also!
    const smtpVerifyPromise = smtpTransport.verify().catch((error) => {
      throw convertSmtpError(error);
    });

    connectionChecks.push(smtpVerifyPromise);
    connectionChecks.push(IMAPConnection.connect({
      settings: Object.assign({}, connectionSettings, connectionCredentials),
      logger: request.logger,
      db: dbStub,
    }));

    Promise.all(connectionChecks).then((results) => {
      for (const result of results) {
        // close any IMAP connections we opened
        if (result && result.end) { result.end(); }
      }

      const accountParams = {
        name: name,
        provider: provider,
        emailAddress: email,
        connectionSettings: connectionSettings,
      }
      return upsertAccount(accountParams, connectionCredentials)
    })
      .then(({account, token}) => {
        const response = account.toJSON();
        response.account_token = token.value;
        reply(JSON.stringify(response));
        return
      })
      .catch((err) => {
        const logger = request.logger.child({
          account_name: name,
          account_provider: provider,
          account_email: email,
          connection_settings: connectionSettings,
          error_name: err.name,
          error_message: err.message,
          error_tb: err.stack,
        })

        if (err instanceof RetryableError) {
          if (retryNum < MAX_RETRIES) {
            setTimeout(() => {
              request.logger.info(`${err.name}. Retry #${retryNum + 1}`)
              authHandler(request, reply, retryNum + 1)
            }, 100)
            return
          }
          logger.error('Encountered retryable error while attempting to authenticate')
          reply({message: err.userMessage, type: "api_error"}).code(err.statusCode);
          return
        }

        logger.error("Error trying to authenticate")
        let userMessage = "Please contact support@nylas.com. An unforeseen error has occurred.";
        let statusCode = 500;
        if (err instanceof NylasError) {
          if (err.userMessage) {
            userMessage = err.userMessage;
          }
          if (err.statusCode) {
            statusCode = err.statusCode;
          }
        }
        reply({message: userMessage, type: "api_error"}).code(statusCode);
        return;
      })
  }
  return authHandler
}
