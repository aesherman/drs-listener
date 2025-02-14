import * as request from "request";
import * as MessageValidator from "sns-validator";

const validator = new MessageValidator();

/**
 * Represents an error from the system
 */
interface IError {
  reason: string;
  code?: string;
  raw: any;
}

/**
 * Represents an incoming notification from SNS
 */
interface IBodySNS {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Subject: string;
  Message: string; // will need to be parsed into a JSON object
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  UnsubscribeURL: string;
  SubscribeURL?: string;
}

/**
 * Represents a specific order
 */
export interface IOrderInfo {
  instanceId: string;
  slotId: string;
  productInfo: IProductInfo[] | any[];
}

/**
 * Represents a product on an order
 */
export interface IProductInfo {
  asin: string;
  quantity?: string;
  unit?: string;
  estimatedDeliveryDate?: string;
}

/**
 * The handlers for each message type
 */
export interface IHandlers {
  // called if there is an error
  onError: (error: IError | null) => any;
  // should only be used if all you care about is validating as no other handlers will be called
  onOnlyValidateMessage?: (message: any) => any;
  // called when the parsed message is a non-DRS message
  onNonDRSMessage?: (message: any) => any;
  // called when a device is deregistered
  onDeviceDeregistered?: (customerId: string, modelId: string, serialNumber: string, raw?: object) => any;
  // called when a device is registered
  onDeviceRegistered?: (customerId: string, modelId: string, serialNumber: string, raw?: object) => any;
  // called when an item is shipped
  onItemShippedNotification?: (customerId: string, modelId: string, serialNumber: string, orderInfo: IOrderInfo, raw?: object) => any;
  // called when an item order is cancelled
  onOrderCancelled?: (customerId: string, modelId: string, serialNumber: string, orderInfo: IOrderInfo, raw?: object) => any;
  // called when an order is placed
  onOrderPlaced?: (customerId: string, modelId: string, serialNumber: string, orderInfo: IOrderInfo, raw?: object) => any;
  // called when a subscription changes
  onSubscriptionChanged?: (customerId: string, modelId: string, serialNumber: string, subscriptionInfo: any, raw?: object) => any;
}

/**
 * represents the currently known message types
 */
const knownMessageTypes = [
  "DeviceDeregisteredNotification",
  "DeviceRegisteredNotification",
  "ItemShippedNotification",
  "OrderCancelledNotification",
  "OrderPlacedNotification",
  "SubscriptionChangedNotification"];

  /**
   * Represents the error codes
   */
export const errorCodes = {
  "invalid_json": "we could not parse the json of the message",
  "invalid_signature": "invalid signature for the incoming message",
  "missing_handler": "missing the handler to handle that notification",
  "not_drs": "this is not a DRS message, we placed it back into the raw property",
  "unknown_message": "unknown message type received",
  "invalid_subscription_request": "could not confirm subscription due to malformed object or missing url",
  "invalid_subscription_request_response": "could not confirm the subscription due to a remote error"
};

// used for handling errors related to non-specificed handlers in the handler object
const missingHandlerError: IError = {
  code: "missing_handler",
  reason: errorCodes.missing_handler,
  raw: {handler: ""}
};

/**
 * Takes the SNS message, for example, from the Express req.body object
 * @param body 
 * @param handlers 
 */
export const receiveRequest = (body: IBodySNS, handlers: IHandlers) => {
  // ensure the message is a valid message from SNS
  validator.validate(body, async (err: IError, parsed: IBodySNS) => {
    if(err){
      const validationError: IError = {
        code: "invalid_signature",
        reason: errorCodes.invalid_signature,
        raw: err
      };
      return handlers.onError(validationError);
    }

    // if this is a confirmation message, we want to confirm it immediately
    // otherwise the rest will fail as the confirmation reques cannot be converted to JSON
    // and the rest of the flow is fairly pointless
    if(parsed.Type === "SubscriptionConfirmation"){
      const url = parsed.SubscribeURL ? parsed.SubscribeURL : "";
      if(url === ""){
        const validationError: IError = {
          code: "invalid_subscription_request",
          reason: errorCodes.invalid_subscription_request,
          raw: parsed
        };
        return handlers.onError(validationError);
      }
      // we need to do a get on the URL
      return request(url, {}, (confirmErr, confirmResponse, confirmBody) => {
        if(err !== null || confirmResponse.statusCode !== 200){
          const validationError: IError = {
            code: "invalid_subscription_request_response",
            reason: errorCodes.invalid_subscription_request_response,
            raw: {
              err: confirmErr,
              resp: confirmResponse,
              body: confirmBody
            }
          };
          return handlers.onError(validationError);
        }
      });
    }
    
    // parse the JSON
    let message: any = {}; 
    try{
      message = JSON.parse(parsed.Message);
    } catch(er) {
      const jsonError: IError = {
        code: "invalid_json",
        reason: errorCodes.invalid_json,
        raw: er
      };
      return handlers.onError(jsonError);
    }

    // there are a few ways this could get to us; we need to check
    // if the top key is default; if it is, the real message is a child
    // the same goes for email, http, or https
    if(message.default && message.default.deviceInfo){
      message = message.default;
    } else if(message.email && message.email.deviceInfo){
      message = message.email;
    } else if(message.http && message.http.deviceInfo){
      message = message.http;
    } else if(message.https && message.https.deviceInfo){
      message = message.https;
    } else if(message.notificationInfo && message.notificationInfo.notificationType){
      // the method of delivery isn't the top level object
      // so we check to see if the top level matches what we expect
      if(knownMessageTypes.indexOf(message.notificationInfo.notificationType) === -1){
        const messageUnknownError: IError = {
          code: "unknown_message",
          reason: errorCodes.unknown_message,
          raw: {message: message.notificationInfo.notificationType}
        };
        return handlers.onError(messageUnknownError);
      }
    } else {
      // this is likely a non-DRS message, so check for the non-drs handler
      // otherwise, on the error it goes
      if(handlers.onNonDRSMessage){
        return handlers.onNonDRSMessage(parsed);
      }
      const drsErr: IError = {
        code: "not_drs",
        reason: errorCodes.not_drs,
        raw: parsed
      };
      return handlers.onError(drsErr);
    }

    // now parse it 
    const serialNumber = message.deviceInfo.deviceIdentifier.serialNumber;
    const modelId = message.deviceInfo.productIdentifier.modelId;
    const messageType = message.notificationInfo.notificationType;
    const customerId = message.customerInfo.directedCustomerId;

    // here is where we should break up the handling into different functions
    // we could also switch on the messageType
    if(messageType === "DeviceDeregisteredNotification"){
      if(handlers.onDeviceDeregistered){
        return handlers.onDeviceDeregistered(customerId, modelId, serialNumber, message);
      }
      missingHandlerError.raw.handler = "onDeviceDeregistered";
      return handlers.onError(missingHandlerError);

    } else if(messageType === "DeviceRegisteredNotification"){
      if(handlers.onDeviceRegistered){
        return handlers.onDeviceRegistered(customerId, modelId, serialNumber, message);
      }
      missingHandlerError.raw.handler = "onDeviceRegistered";
      return handlers.onError(missingHandlerError);

    } else if(messageType === "ItemShippedNotification"){
      if(handlers.onItemShippedNotification){
        const orderInfo: IOrderInfo = {
          instanceId: message.orderInfo.instanceId ? message.orderInfo.instanceId : "",
          slotId: message.orderInfo.slotId ? message.orderInfo.slotId : "",
          productInfo: message.orderInfo.productInfo
        };
        return handlers.onItemShippedNotification(customerId, modelId, serialNumber, orderInfo, message);
      }
      missingHandlerError.raw.handler = "onItemShippedNotification";
      return handlers.onError(missingHandlerError);

    } else if(messageType === "OrderCancelledNotification"){
      if(handlers.onOrderCancelled){
        const orderInfo: IOrderInfo = {
          instanceId: message.orderInfo.instanceId ? message.orderInfo.instanceId : "",
          slotId: message.orderInfo.slotId ? message.orderInfo.slotId : "",
          productInfo: [] // no product info on an order cancelled notification
        };
        return handlers.onOrderCancelled(customerId, modelId, serialNumber, orderInfo, message);
      }
      missingHandlerError.raw.handler = "onOrderCancelled";
      return handlers.onError(missingHandlerError);

    } else if(messageType === "OrderPlacedNotification"){
      if(handlers.onOrderPlaced){
        const orderInfo: IOrderInfo = {
          instanceId: message.orderInfo.instanceId ? message.orderInfo.instanceId : "",
          slotId: message.orderInfo.slotId ? message.orderInfo.slotId : "",
          productInfo: message.orderInfo.productInfo
        };
        return handlers.onOrderPlaced(customerId, modelId, serialNumber, orderInfo, message);
      }
      missingHandlerError.raw.handler = "onOrderPlaced";
      return handlers.onError(missingHandlerError);
      
    } else if(messageType === "SubscriptionChangedNotification"){
      if(handlers.onSubscriptionChanged){
        const subscriptionInfo = message.subscriptionInfo ? message.subscriptionInfo : {};
        return handlers.onSubscriptionChanged(customerId, modelId, serialNumber, subscriptionInfo.slotsSubscriptionStatus, message);
      }
      missingHandlerError.raw.handler = "onSubscriptionChanged";
      return handlers.onError(missingHandlerError);
    }
  });
};

export const validate = (message: any, handlers?: IHandlers, callback?: (err: any, message: any) => any): Promise<any> | any => {
  // if there are no handlers and no call back, then it's a promise they desire
  const isPromise = (handlers === null || handlers === undefined) && (callback === null || callback === undefined);
  if(isPromise){
    return new Promise((resolve, reject) => {
      validator.validate(message, async (err: IError, parsed: IBodySNS) => {
        if(err){
          const validationError: IError = {
            code: "invalid_signature",
            reason: errorCodes.invalid_signature,
            raw: err
          };
          return reject(validationError);
        }
        return resolve(parsed);
      });
    });
  }
  // not a promise, handle with call backs
  validator.validate(message, async (err: IError, parsed: IBodySNS) => {
    if(err){
      const validationError: IError = {
        code: "invalid_signature",
        reason: errorCodes.invalid_signature,
        raw: err
      };
      if(handlers && handlers.onError){
        return handlers.onError(validationError);
      } else if(callback){
        return callback(validationError, message);
      }
    }
    if(handlers && handlers.onOnlyValidateMessage){
      return handlers.onOnlyValidateMessage(parsed);
    } else if(callback){
      return callback(null, parsed);
    } 
  });
};