/**
 * Adapter for integration of Gardena Smart System to ioBroker
 * based on official GARDENA smart system API (https://developer.1689.cloud/)
 * Support:             https://forum.iobroker.net/...
 * Autor:               jpgorganizer (ioBroker) | jpgorganizer (github)
 * SVN:                 $Rev: 2133 $ ($Date: 2020-06-03 22:52:48 +0200 (Mi, 03 Jun 2020) $)
 * contains some functions available at forum.iobroker.net, see function header
 */
"use strict";

// some variables 
const apirev = '$Rev: 2133 $';
const request = require('request'); // for communication
const websocket = require('ws');
const unixTimeZero = '1970-01-01T00:00:00Z'; //Date.parse('01 Jan 1970 00:00:00Z');
const minMowerHistoryCycles = 3;

const ju = require('@jpgorganizer/utils').utils;

const PDDP = require('./predefdp.js');
const gardenaServicesDataPoints = PDDP.gardenaServicesDataPoints;

let HF = require('./history.js')
let HistoryForecast = HF.HistoryForecast;

const UNDEFINED = 'undefined';

// supported Gardena servicess
const gardenaServices = [{
		servicename: 'SERVICE_COMMON',
		control: ''
	},
	{
		servicename: 'SERVICE_MOWER',
		control: 'MOWER_CONTROL'
	},
	{
		servicename: 'SERVICE_POWER_SOCKET',
		control: 'POWER_SOCKET_CONTROL'
	},
	{
		servicename: 'SERVICE_SENSOR',
		control: ''
	},
	{
		servicename: 'SERVICE_VALVE',
		control: 'VALVE_CONTROL'
	},
	{
		servicename: 'SERVICE_VALVE_SET',
		control: 'VALVE_SET_CONTROL'
	}
];
const IRRWHILEMOWING_ALLOWED = 'irrigationWhileMowing_allowed_i';
const IRRWHILEMOWING_MOWER_DEFINITION = 'irrigationWhileMowing_mowerDefinition_i';
const IRRWHILEMOWING_WARNING = 'irrigationWhileMowing_warningCode_i';
const IRRWHILEMOWING_WARNING_NOWARNING = 'NO_WARNING';
const IRRWHILEMOWING_WARNING_UNKNOWN = 'UNKNOWN_MOWER';
const IRRWHILEMOWING_WARNING_STOPPED = 'STOPPED';
const IRRWHILEMOWING_WARNING_FORBIDDEN = 'FORBIDDEN';
const IRRWHILEMOWING_CODE_FORBIDDEN = 'IRRIGATION_FORBIDDEN';



let sortedGardenaServices = gardenaServices.sort(ju.arraySort('-servicename'));
let adapter;
let auth;
let PostOAuth2Response;
let locations;
let locationid;
let websocketresp;
let websocketurl;
let websocketclient = null;
let client = null;
let gardena_smart_host;
let gardena_api_key;
let gardena_ping_frequence;
let gardena_refresh_token;
let refresh_timer = null;
let configUseTestVariable = false;
let configUseMowerHistory = false;
let configMowerHistoryCycles = 2;
let configUseIrrigationAllowedWhileMowing = false;
let heartbeat_interval = null;
let missed_heartbeats = 0;
const max_missed_heartbeats = 3;
let leftoverTimer = [];
let multiMowHistory;
let multiChargeHistory;
let internSaveState = {};

function matchRuleShort(str, rule) {
  var escapeRegex = (str) => str.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
  return new RegExp("^" + rule.split("*").map(escapeRegex).join(".*") + "$").test(str);
}


/**
 * checks a date string 
 * @param   {string} dateStr  date string
 * @return  {number}  -2, if its a not a date string
 *                    -1, if its a valid date/time string, 
 *                   >=0, the number of milliseconds, if its a number
 */
function isValidDate(dateStr) {
	if(isNaN(dateStr)){ //Checked for numeric
		let dt = new Date(dateStr);
		if (isNaN(dt.getTime())) { //Checked for date
			return -2; // no date string
		} else {
			return -1; // valid date string
		}
	} else {
		//let dt = new Date(parseInt(dateStr));
		return parseInt(dateStr); // number
	}
}

/*
 * Encode's a string
 * @param    s    string
 * @return   encoded string
 */
function sgEncode(s) {
	let x = encodeURIComponent(s);
	x = ju.replaceAll(x, '-', '%2D');
	x = ju.replaceAll(x, '%', '-');

	return x;
}

/*
 * Decode's a string
 * @param    s    string
 * @return   decoded string 
 */
function sgDecode(s) {
	let x = ju.replaceAll(s, '-', '%');
	x = ju.replaceAll(x, '%2D', '-');
	x = decodeURIComponent(x);

	return x;
}

/**
 * Deletes and stops leftovertimer if available in leftoverTimer array
 * @param  {string}    id of duration_leftover_i datapoint
 */
function deleteLeftoverTimer(id) {
	let i;
	for (i = 0; i < leftoverTimer.length; i++) {
		if (leftoverTimer[i].id === id) {
			clearTimeout(leftoverTimer[i].timer);
			leftoverTimer.splice(i, 1);
			break;
		}
	}
}

/**
 * Adds leftovertimer to leftoverTimer array
 * @param  {string}    id of duration_leftover_i datapoint
 * @param  (Timeout object) timer from call to setTimeout()
 */
function addLeftoverTimer(id, timer) {
	let leftoverTimerElement;

	// make sure that there is no such timer
	deleteLeftoverTimer(id);

	leftoverTimerElement = new Object();
	leftoverTimerElement = {
		id: id,
		timer: timer
	};
	leftoverTimer.push(leftoverTimerElement);
}

/**
 * Ermittelt die Restlaufzeit eines Timers in Minuten und schreibt den Wert in einen Status 
 * Startet einen neuen Timer mit Laufzeit von einer (1) Minute, sofern die Restlaufzeit größer als
 * eine Minute ist. Der Wert der Restlaufzeit wird nur gesetzt, wenn Restlaufzeit größer/gleich als eine Minute ist.
 * Ist die Restlaufzeit < 1, dann wird der Wert nicht mehr geändert
 * @param   {string}   tim            id des state in dem die Restlaufzeit des Timers steht und neu gesetzt wird
 */
function setLeftOverTimer(tim) {
	//setTimeout(setLeftOverTimer, 60*1000, nx, name + '.duration_timestamp', activitytimer.timestamp);
	let mytim = tim;
	let difference;
	let timer;

	deleteLeftoverTimer(mytim);

	adapter.getState(sgEncode(mytim), function(err, state) {
		if (state.val !== 'null' && state.val > 1) { //!== '1') {
			difference = state.val - 1;
			sgSetState(mytim, difference);
			if (difference > 1) {
				timer = setTimeout(setLeftOverTimer, 60 * 1000, mytim); //, state_dts, state_dts_val);
				addLeftoverTimer(mytim, timer);
			}
		}
	});
}

/**
 * Sendet ein Kommando an das Gardena smart system
 * unterstützte Services: SERVICE_POWER_SOCKET
 * @param   {string}  id (encoded)
 * @param   {object}  state
 */
exports.sendCommand = function(id, state) {

	let service = '';
	let service_command = '';
	let service_control = '';
	let serviceid = '';
	let value = 0;

	id = sgDecode(id);
	let arr = id.split('.');
	let status = arr[arr.length - 1];

	let name = '';
	for (let i = 0; i < arr.length - 1; i++) {
		name = name + arr[i] + '.';
	}
	name = name.substr(0, name.length - 1); // just delete trailing '.'

	// looking for the changed Gardena service; loop over the possible values; stop if found
	// depends on initial values of ...
	for (let i = 0, temp = -1; i < sortedGardenaServices.length; i++) {
		temp = arr[arr.length - 2].search(sortedGardenaServices[i].servicename);
		if (temp !== -1) { // service found 
			service = sortedGardenaServices[i].servicename;
			service_control = sortedGardenaServices[i].control;
			break;
		}
	}

	if (service !== '' && service_control !== '' && arr.length >= 2) { // all cond should be true at the same time, just to be on the safe side
		serviceid = arr[arr.length - 2].slice(service.length + 1); // without leading underscore

		switch (service) {
			case 'SERVICE_POWER_SOCKET':
				{
					switch (status) {
						case 'duration_value':
							//    START_SECONDS_TO_OVERRIDE - Manual operation, use 'seconds' attribute to define duration.
							//    START_OVERRIDE - Manual 'on'
							//    STOP_UNTIL_NEXT_TASK - Immediately switch 'off', continue with the schedule.
							//    PAUSE - Skip automatic operation until specified time. The currently active operation will NOT be cancelled.
							//    UNPAUSE - Restore automatic operation if it was paused.
							switch (state.val) {
								case 'START_OVERRIDE':
								case 'STOP_UNTIL_NEXT_TASK':
								case 'PAUSE':
								case 'UNPAUSE':
									service_command = state.val;
									break;
								default:
									service_command = 'START_SECONDS_TO_OVERRIDE';
									value = parseInt(state.val);
									if (value === NaN) value = 60; // seconds
									value = value - (value % 60); // make sure that we have multiples of 60 seconds
									break;
							}

							let options_power_socket_control = {
								url: gardena_smart_host + '/v1/command/' + serviceid,
								method: 'PUT',
								json: true,
								headers: {
									'accept': '*/*',
									'Content-Type': 'application/vnd.api+json',
									'Authorization': 'Bearer ' + auth,
									'Authorization-Provider': 'husqvarna',
									'X-Api-Key': gardena_api_key
								},
								json: {
									data: {
										'id': 'cmdid_' + service_command,
										'type': service_control,
										'attributes': {
											'command': service_command,
											'seconds': value
										}
									}
								}
							};

							request(options_power_socket_control, function(err, response, body) {
								ju.adapterloginfo(3, "request power socket ...");
								if (err || !response || response.statusCode >= 300) {
									// failure
									ju.adapterloginfo(1, 'Power Socket Command failure.');
									if (err) {
										ju.adapterloginfo(1, err);
									}
									if (response) {
										ju.adapterloginfo(1, 'Power Socket command failure: response.statusCode/Message=' + response.statusCode + '/' + response.statusMessage);
									}
								} else {
									// successful
									ju.adapterloginfo(1, 'Power Socket Command: successful response.statusCode/Message=' + response.statusCode + '/' + response.statusMessage);
								}
							})
							break;
						default:
							setSaveState(sgEncode(id), state.val);
							break;
					}
					break;
				}
			case 'SERVICE_MOWER':
				{
					switch (status) {
						case 'activity_control_i':
							//    START_SECONDS_TO_OVERRIDE - Manual operation, use 'seconds' attribute to define duration.
							//    START_DONT_OVERRIDE - Automatic operation.
							//    PARK_UNTIL_NEXT_TASK - Cancel the current operation and return to charging station.
							//    PARK_UNTIL_FURTHER_NOTICE - Cancel the current operation, return to charging station, ignore schedule.
							switch (state.val) {
								case 'START_DONT_OVERRIDE':
								case 'PARK_UNTIL_NEXT_TASK':
								case 'PARK_UNTIL_FURTHER_NOTICE':
									service_command = state.val;
									break;
								default:
									service_command = 'START_SECONDS_TO_OVERRIDE';
									value = parseInt(state.val);
									if (value === NaN) value = 60; // seconds
									value = value - (value % 60); // make sure that we have multiples of 60 seconds
									break;
							}

							let options_mower_control = {
								url: gardena_smart_host + '/v1/command/' + serviceid,
								method: 'PUT',
								json: true,
								headers: {
									'accept': '*/*',
									'Content-Type': 'application/vnd.api+json',
									'Authorization': 'Bearer ' + auth,
									'Authorization-Provider': 'husqvarna',
									'X-Api-Key': gardena_api_key
								},
								json: {
									data: {
										'id': 'cmdid_' + service_command,
										'type': service_control,
										'attributes': {
											'command': service_command,
											'seconds': value
										}
									}
								}
							};

							request(options_mower_control, function(err, response, body) {
								if (err || !response || response.statusCode >= 300) {
									// failure
									ju.adapterloginfo(1, 'Mower Command failure.');
									if (err) {
										ju.adapterloginfo(1, err);
									}
									if (response) {
										ju.adapterloginfo(1, 'Mower command failure: response.statusCode/Message=' + response.statusCode + '/' + response.statusMessage);
									}
								} else {
									// successful
									ju.adapterloginfo(1, 'Mower Command: successful response.statusCode/Message=' + response.statusCode + '/' + response.statusMessage);
								}
							})
							break;
						default:
							setSaveState(sgEncode(id), state.val);
							break;
					}
					break;
				}
			case 'SERVICE_VALVE_SET':
				{
					switch (status) {
						case 'stop_all_valves_i':
							{
								switch (state.val) {
									case 'STOP_UNTIL_NEXT_TASK':
										{
											service_command = state.val;

											let options_valve_set_control = {
												url: gardena_smart_host + '/v1/command/' + serviceid,
												method: 'PUT',
												json: true,
												headers: {
													'accept': '*/*',
													'Content-Type': 'application/vnd.api+json',
													'Authorization': 'Bearer ' + auth,
													'Authorization-Provider': 'husqvarna',
													'X-Api-Key': gardena_api_key
												},
												json: {
													data: {
														'id': 'cmdid_' + service_command,
														'type': service_control,
														'attributes': {
															'command': service_command
														}
													}
												}
											};
											request(options_valve_set_control, function(err, response, body) {
												if (err || !response || response.statusCode >= 300) {
													// failure
													ju.adapterloginfo(1, 'Valve Set Command failure.');
													if (err) {
														ju.adapterloginfo(1, err);
													}
													if (response) {
														ju.adapterloginfo(1, 'Valve Set command failure: response.statusCode/Message=' + response.statusCode + '/' + response.statusMessage);
													}
												} else {
													// successful
													ju.adapterloginfo(1, 'Valve Set Command: successful response.statusCode/Message=' + response.statusCode + '/' + response.statusMessage);
												}
											})
											sgSetState(id, 'null'); // reset command datapoint
											break;
										}
									default:
										break;
								}
								break;
							}
						default:
							setSaveState(sgEncode(id), state.val);
							break;
					}
					break;
				}
			case 'SERVICE_VALVE':
				{
					switch (status) {
						case 'duration_value':
							{
								// START_SECONDS_TO_OVERRIDE - Manual operation, use 'seconds' attribute to define duration.
								// STOP_UNTIL_NEXT_TASK - Cancel the current watering, continue with the schedule.
								// PAUSE - Skip automatic operation until specified time. The currently active operation might or might not be cancelled (depends on device model).
								// UNPAUSE - Restore automatic operation if it was paused.
								switch (state.val) {
									case 'STOP_UNTIL_NEXT_TASK':
									case 'PAUSE':
									case 'UNPAUSE':
										service_command = state.val;
										break;
									default:
										service_command = 'START_SECONDS_TO_OVERRIDE';
										value = parseInt(state.val);
										if (value === NaN) value = 60; // seconds
										value = value - (value % 60); // make sure that we have multiples of 60 seconds

										// check mower
										// 'SHOULDOPEN' is just a value that is not 'CLOSED'
										// 'NOEXEC' means that valve must not be closed, just checked
										checkAndSetIrrigationAllowedWhileMowing(name, '.activity_value', 'VALVE', 'SHOULDOPEN', 'NOEXEC');

										// check warning
										let w = getSaveState(sgEncode(name + '.' + IRRWHILEMOWING_WARNING));
										// if STOPPED or FORBIDDEN, we don't open, but close instead
										if (w.search(IRRWHILEMOWING_WARNING_STOPPED) !== -1 || w.search(IRRWHILEMOWING_WARNING_FORBIDDEN) !== -1) {
											service_command = 'STOP_UNTIL_NEXT_TASK';
											value = 0;
										}
										break;
								}

								let options_valve_control = {
									url: gardena_smart_host + '/v1/command/' + serviceid,
									method: 'PUT',
									json: true,
									headers: {
										'accept': '*/*',
										'Content-Type': 'application/vnd.api+json',
										'Authorization': 'Bearer ' + auth,
										'Authorization-Provider': 'husqvarna',
										'X-Api-Key': gardena_api_key
									},
									json: {
										data: {
											'id': 'cmdid_' + service_command,
											'type': service_control,
											'attributes': {
												'command': service_command,
												'seconds': value
											}
										}
									}
								};

								request(options_valve_control, function(err, response, body) {
									if (err || !response || response.statusCode >= 300) {
										// failure
										ju.adapterloginfo(1, 'Valve Command failure.');
										if (err) {
											ju.adapterloginfo(1, err);
										}
										if (response) {
											ju.adapterloginfo(1, 'Valve command failure: response.statusCode/Message=' + response.statusCode + '/' + response.statusMessage);
										}
									} else {
										// successful
										ju.adapterloginfo(1, 'Valve Command: successful response.statusCode/Message=' + response.statusCode + '/' + response.statusMessage);
									}
								})
								break;
							}
						default:
							setSaveState(sgEncode(id), state.val, true);
							break;
					}
					break;
				}
			default:
				{
					ju.adapterloginfo(1, 'Command failure. Service ' + service + ' not supported');
				}
		}
	}
}

function getSavedServices(service) {
	let name;
	let retArr = [];
	let state;
	let aState;

	for (state in gardenaServicesDataPoints[service]) {
		aState = state;
		break;
	}

	for (name in internSaveState) {
		if (name.search(service) !== -1) {
			let pos = name.search('.' + aState);
			if (pos !== -1) {
				// SERVICE_VALVE_SET contains SERVICE_VALVE, 
				// so make sure we have the right one
				if (service === 'SERVICE_VALVE') {
					if (name.search('SERVICE_VALVE_SET') === -1) {
						retArr.push(name.substring(0, pos));
					}
				} else {
					retArr.push(name.substring(0, pos));
				}
			}
		}
	}

	return retArr;
}

/**
 * saves state in internal object
 * @param   {string}  s    state
 * @param   {object}  v    value
 */
function setSaveState(s, v, log) {
	let sarr = s.split('.');

	if (log === undefined) {
		log = false;
	}

	if (sarr[0] === adapter.name) {
		let t = adapter.name + '.' + adapter.instance + '.';
		s = s.substr(t.length);
	}

	internSaveState[s] = v;

	if (log === true) {
		let bs = beautifyStateId(s);
		let t = 'sgSetSaveState: ' + bs + ' value=' + v;
		ju.consolelog(3, ju.curTime() + ' ' + t);
		ju.adapterloginfo(3, t);
	}
}

/**
 * returns value of state in internal object
 * @param   {string}  s    state id, encoded
 * @return  value of state or 'undefined' if state is not available
 */
function getSaveState(s) {
	let sarr = s.split('.');

	if (sarr[0] === adapter.name) {
		let t = adapter.name + '.' + adapter.instance + '.';
		s = s.substr(t.length);
	}

	if (internSaveState.hasOwnProperty(s)) {
		return internSaveState[s];
	} else {
		return UNDEFINED;
	}
}


/**
 * returns value of state in internal object using wildcard 
 * @param   {string}  s1    first part of state id, encoded, without any wildcard
 * @param   {string}  wildcard    rule/wildcard, not encoded
 * @param   {string}  s2    last part of state id, encoded, without any wildcard
 * @return  value of first matching state or 'undefined' if no matching state is found
 * function searches for 's1+s2' first and if that is  not found it trys to 
 * find an id matching 's1+wildcard+s2'
 */
function getSaveStateWildcard(s1, wildcard, s2) {
	
	let r = getSaveState(s1 + s2);
	if (r !== UNDEFINED) {
		return r;
	}
	
	let sarr = s1.split('.');
	
	if (sarr[0] === adapter.name) {
		let t = adapter.name + '.' + adapter.instance + '.';
		s1 = s1.substr(t.length);
	}
	let s = s1 + wildcard + s2;
	
	for (let id in internSaveState) {
		if (matchRuleShort(id, s) === true) {
			return internSaveState[id];
			break;
		}
	}
	return UNDEFINED;
}


/**
 * returns name of state in internal object using wildcard 
 * @param   {string}  s1    first part of state id, encoded, without any wildcard
 * @param   {string}  wildcard    rule/wildcard, not encoded
 * @param   {string}  s2    last part of state id, encoded, without any wildcard
 * @return  name of first matching state or 'undefined' if no matching state is found
 */
function getSaveStateNameWildcard(s1, wildcard, s2) {
	let adapter_instance = '';
	let r = getSaveState(s1 + '.activity_value');
	if (r !== UNDEFINED) {
		return s1 + s2;
	}
	
	let sarr = s1.split('.');
	
	if (sarr[0] === adapter.name) {
		adapter_instance = adapter.name + '.' + adapter.instance + '.';
		s1 = s1.substr(adapter_instance.length);
	}
	let s = s1 + wildcard + '.activity_value';
	
	for (let id in internSaveState) {
		if (matchRuleShort(id, s) === true) {
			s = id.substr(0, id.length - '.activity_value'.length);	
			return adapter_instance + s + s2;
			break;
		}
	}
	return UNDEFINED;
}



/**
 * saves state in internal object, if state is not yet saved 
 * if state is not set yet
 * @param   {string}  s    encoded state id
 * @param   {object}  v    value
 */
function sgSaveStateNotExists(s, v) {
	if (getSaveState(s) === UNDEFINED) {
		// state is not in internal list,
		setSaveState(s, v);
		adapter.getState(s, function(err, state) {
			if (!err && state) {
				setSaveState(s, state.val);
			}
		});
	}
}


/**
 * Setzt den Wert für einen gegebenen Status mit ack=true
 * @param   {string}  s    state, not encoded
 * @param   {object}  v    zu setzender Wert
 */
function sgSetStateAck(s, v, ack) {
	//s=smartgarden.0.LOCATION_185b1234-cd2a-4f99-759a-b16c124347cf.DEVICE_864567d6-92c1-417a-1205-f6e6a3e5127e.SERVICE_COMMON_864567d6-92c1-417a-1205-f6e6a3e5127e.rfLinkState_value
	let bs = beautifyStateId(s);
	let t = 'sgSetState: ' + bs + ' value=' + v + ' ack=' + ack;
	let sEncode = sgEncode(s);

	ju.consolelog(3, ju.curTime() + ' ' + t);
	ju.adapterloginfo(3, t);
	setSaveState(sEncode, v);
	adapter.setState(sEncode, v, ack);
}

/**
 * Setzt den Wert für einen gegebenen Status mit ack=true
 * @param   {string}  s    state, not encoded
 * @param   {object}  v    zu setzender Wert
 */
function sgSetState(s, v) {
	sgSetStateAck(s, v, true);
}

/**
 * beautifying the state id / shortening srare id
 * just for better reading
 * @param   {string}  s    state id
 * @return  {string}  v    beautified state id
 */
function beautifyStateId(s) {
	//s=smartgarden.0.LOCATION_185b1234-cd2a-4f99-759a-b16c124347cf.DEVICE_864567d6-92c1-417a-1205-f6e6a3e5127e.SERVICE_COMMON_864567d6-92c1-417a-1205-f6e6a3e5127e.rfLinkState_value
	// smartgarden.
	// 0.
	// LOCATION_185b1234-cd2a-4f99-759a-b16c124347cf.
	// DEVICE_864567d6-92c1-417a-1205-f6e6a3e5127e.
	// SERVICE_COMMON_864567d6-92c1-417a-1205-f6e6a3e5127e.
	// rfLinkState_value
	// 
	// sg.
	// 0.
	// L_b16c124347cf.
	// D_f6e6a3e5127e.
	// S_COMMON_f6e6a3e5127e.
	// rfLinkState_value

	let sarr = s.split('.');
	let r = '';
	for (let i = 0; i < sarr.length; i++) {
		if (sarr[i] === adapter.name) {
			sarr[i] = 'sg'
		} else {
			if ((sarr[i].search('LOCATION') !== -1) || (sarr[i].search('DEVICE') !== -1) || (sarr[i].search('SERVICE') !== -1)) {
				let larr = sarr[i].split('_');
				let iarr = larr[larr.length - 1].split('-');
				if (larr.length > 3) {
					sarr[i] = larr[0].substr(0, 1) + '_' + larr[1] + '_' + larr[2] + '_' + iarr[iarr.length - 1].substr(iarr[iarr.length - 1].length - 4, 4);
				} else {
					if (larr.length > 2) {
						sarr[i] = larr[0].substr(0, 1) + '_' + larr[1] + '_' + iarr[iarr.length - 1].substr(iarr[iarr.length - 1].length - 4, 4);
					} else {
						sarr[i] = larr[0].substr(0, 1) + '_' + iarr[iarr.length - 1].substr(iarr[iarr.length - 1].length - 4, 4); //iarr[iarr.length - 1];
					}
				}
			}
		}
		if (r === '') {
			r = sarr[i];
		} else {
			r = r + '.' + sarr[i];
		}
	}
	return r;
}

/**
 * erneuert das authentification token und reconnect des websocketclients
 * nutzt Variablen in adapter.config 
 */
function reconnectWithRefreshToken() {
	ju.consolelog(1, '### ' + ju.curTime() + " reconnectWithRefreshToken!!!!");
	ju.adapterloginfo(1, 'reconnectWithRefreshToken!!!!');

	let gardena_authentication_host = adapter.config.gardena_authentication_host.trim();
	let gardena_authtoken_factor = adapter.config.gardena_authtoken_factor;
	gardena_api_key = adapter.config.gardena_api_key.trim();

	if (heartbeat_interval !== null) {
		clearInterval(heartbeat_interval);
		heartbeat_interval = null;
	}

	if (refresh_timer !== null) {
		clearTimeout(refresh_timer);
		refresh_timer = null;
	}
	if (websocketclient !== null) {
		ju.consolelog(1, '### ' + ju.curTime() + " reconnectWithRefreshToken: close former websocket");
		websocketclient.close();
		websocketclient = null;
	}

	if (gardena_refresh_token === undefined || gardena_refresh_token === '') {
		ju.consolelog(1, '### ' + ju.curTime() + ' Refresh: refreshtoken undefined');
		ju.adapterloginfo(1, 'Refresh: refreshtoken undefined');
	} else {

		let options_refresh = {
			url: gardena_authentication_host + '/v1/oauth2/token',
			method: 'POST',
			json: true,
			headers: {
				'accept': 'application/json',
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			form: {
				'grant_type': 'refresh_token',
				'refresh_token': gardena_refresh_token,
				'client_id': gardena_api_key
			}
		};

		// invalidate gardena_refresh_token + auth
		gardena_refresh_token = '';
		auth = '';

		request(options_refresh, function(err, response, body) {
			if (err || !response) {
				// no connection or auth failure
				adapter.log.error(err);
				ju.adapterloginfo(1, 'Refresh failure.');
				sgSetState('info.connection', false);

				if (err) {
					ju.adapterloginfo(1, 'Refresh error=' + err);
				}
				if (!response) {
					ju.adapterloginfo(1, 'Refresh failure/no response.');
				}
			} else {
				// connection successful
				ju.adapterloginfo(1, 'Refresh: successful response.statusCode/Message=' + response.statusCode + '/' + response.statusMessage);

				ju.adapterloginfo(1, 'Refresh: access token changed');
				auth = response.body.access_token;

				ju.adapterloginfo(1, 'Refresh: refresh_token changed');
				gardena_refresh_token = response.body.refresh_token;

				sgSetState('info.connection', true);

				let timeout = Math.round(response.body.expires_in * gardena_authtoken_factor);
				if (timeout < 600) {
					ju.consolelog(1, '### ' + ju.curTime() + ' Refresh: possible wrong timeout for authtoken=' + timeout);
					ju.adapterloginfo(1, 'Refresh: possible wrong timeout for authtoken=' + timeout);
				}
				refresh_timer = setTimeout(reconnectWithRefreshToken, timeout * 1000);

				exports.get_websocket(function(err, websocket) {
					if (err) {
						adapter.log.error(err);
						sgSetState('info.connection', false);
						if (err) {
							ju.adapterloginfo(1, 'get_websocket failure, error=' + err);
						}
					} else {
						ju.consolelog(1, '### ' + ju.curTime() + " Refresh: get_websocket");
						ju.adapterloginfo(1, 'Refresh: get_websocket ... websocket=' + websocket);
						sgSetState('info.connection', true);
					}
				});
			}
		})
	}
}

function mowerIsMowing(val) {
	let ret = false;

	switch (val) {
		case 'OK_CHARGING': // - The mower has to be mowing but insufficient charge level keeps it in the charging station.
		case 'PARKED_TIMER': // - The mower is parked according to timer, will start again at configured time.
		case 'PARKED_PARK_SELECTED': // - The mower is parked until further notice.
		case 'PARKED_AUTOTIMER': // - The mower skips mowing because of insufficient grass height.
		case 'PAUSED': // - The mower in a waiting state with hatch closed.
			ret = false; // NOT_MOWING
			break;
		case 'OK_CUTTING': // - The mower id cutting in AUTO mode (schedule).
		case 'OK_CUTTING_TIMER_OVERRIDDEN': // - The mower is cutting outside schedule.
		case 'OK_SEARCHING': // - The mower is searching for the charging station.
		case 'OK_LEAVING': // - The mower is leaving charging station.
		case 'NONE': // - No activity is happening, perhaps due to an error.
		default:
			ret = true; // MOWING
			break;
	}

	return ret;
}

/**
 * handles special states for mower
 * @param   {string}  name    path of state
 * @param   {string}  a       state
 * @param   {string}  type    message type
 * @param   {object}  propval value
 */
function setMower(name, a, type, propval) {
	// create internal datapoint 'activity_mowing_i' for MOWER 
	// only if we've got activity_value from service
	if (a === '.activity_value') {
		let val_i = true; // its safer to say MOWING instead to say nothing
		let x1 = '.activity_mowing_i';
		let nx1 = name + x1;

		val_i = mowerIsMowing(propval);

		adapter.setObjectNotExists(sgEncode(nx1), {
			type: 'state',
			common: {
				name: x1.substr(1),
				type: 'boolean',
				role: 'indicator.working',
				read: true,
				write: false,
			},
			native: val_i,
		});
		sgSetState(nx1, val_i);

		// create internal datapoint to give possibility to control the mower
		val_i = 'null';
		x1 = '.activity_control_i';
		nx1 = name + x1;
		adapter.setObjectNotExists(sgEncode(nx1), {
			type: 'state',
			common: {
				name: x1.substr(1),
				type: 'string',
				role: 'text',
				read: true,
				write: true,
			},
			native: val_i,
		});
		sgSetState(nx1, val_i);
	}
}

/**
 * handles special states for valveset
 * @param   {string}  name    path of state
 * @param   {string}  a       state
 * @param   {string}  type    message type
 * @param   {object}  propval value
 */
function setValveSet(name, a, type, propval) {
	// for irrigation control (VALVE_SET) 
	// create internal datapoint 'stop_all_valves_i' to give
	// possibility to stop all valves with one command
	if (a === '.state_value') {
		let val_i = 'null';
		let x1 = '.stop_all_valves_i';
		let nx1 = name + x1;

		adapter.setObjectNotExists(sgEncode(nx1), {
			type: 'state',
			common: {
				name: x1.substr(1),
				type: 'string',
				role: 'text',
				read: true,
				write: true,
			},
			native: val_i,
		});
		sgSetState(nx1, val_i);
	}

}

/**
 * handles special states for valve
 * @param   {string}  name    path of state
 * @param   {string}  a       state
 * @param   {string}  type    message type
 * @param   {object}  propval value
 */
function setValve(name, a, type, propval) {
	let val_i;
	let x1;
	let nx1;

	if (configUseIrrigationAllowedWhileMowing === true) {
		// create internal datapoints 
		// 'irrigationWhileMowing_allowed_i'
		// 'irrigationWhileMowing_mowerDefinition_i'
		// 'irrigationWhileMowing_error_i'	
		if (a === '.activity_value') {
			val_i = true;
			x1 = '.' + IRRWHILEMOWING_ALLOWED;
			nx1 = name + x1;

			adapter.setObjectNotExists(sgEncode(nx1), {
				type: 'state',
				common: {
					name: x1.substr(1),
					type: 'boolean',
					role: 'switch.enable',
					read: true,
					write: true,
					def: val_i
				},
				native: val_i,
			});
			sgSaveStateNotExists(sgEncode(nx1), val_i);

			val_i = IRRWHILEMOWING_WARNING_NOWARNING;
			x1 = '.' + IRRWHILEMOWING_WARNING;
			nx1 = name + x1;
			adapter.setObjectNotExists(sgEncode(nx1), {
				type: 'state',
				common: {
					name: x1.substr(1),
					type: 'string',
					role: 'text',
					read: true,
					write: false,
					def: val_i
				},
				native: val_i,
			});
			sgSaveStateNotExists(sgEncode(nx1), val_i);

			val_i = '';
			x1 = '.' + IRRWHILEMOWING_MOWER_DEFINITION;
			nx1 = name + x1;
			adapter.setObjectNotExists(sgEncode(nx1), {
				type: 'state',
				common: {
					name: x1.substr(1),
					type: 'string',
					role: 'text',
					read: true,
					write: true,
					def: val_i
				},
				native: val_i,
			});
			sgSaveStateNotExists(sgEncode(nx1), val_i);
		}
	}
}

/**
 * builds error code
 * @param     {string}  warningcode      current warningcode
 * @returns   {string}  newerrorcode   new warningcode to add
 */
function buildWarningcode(warningcode, newerrorcode) {
	if (warningcode === '') {
		warningcode = newerrorcode;
	} else {
		warningcode = warningcode + '+' + newerrorcode;
	}

	return warningcode;
}


/**
 * sets irrigation error code
 * @param   {string}  name    path of error state, not encoded,
 * @param   {string}  e       warningcode
 */
function setIrrigationWarning(name, e) {
	if (getSaveState(sgEncode(name + '.' + IRRWHILEMOWING_WARNING)) !== e) {
		sgSetState(name + '.' + IRRWHILEMOWING_WARNING, e);
	}
}


/**
 * handles if irrigation is allowed while mowing
 * @param   {string}  name    path of state, not encoded
 * @param   {string}  a       state
 * @param   {string}  type    message type
 * @param   {string}  propval value
 * @param   {string}  option  if 'NOEXEC', then valve is not closed if it should, but warning is set
 */
function checkAndSetIrrigationAllowedWhileMowing(name, a, type, propval, option) {
	let mowerDefinitionString;
	let mowerRunning;
	let mowerArr = [];
	let warningcode;
	let valvesArr;
	let forthismower;

	if (option === undefined || option !== 'NOEXEC') {
		option = 'EXEC';
	}

	if (configUseIrrigationAllowedWhileMowing === true) {
		switch (type) {
			case 'VALVE':
				if (a === '.activity_value') {
					if (propval !== 'CLOSED') {
						if (getSaveState(sgEncode(name + '.' + IRRWHILEMOWING_ALLOWED)) === false) {
							mowerDefinitionString = getSaveState(sgEncode(name + '.' + IRRWHILEMOWING_MOWER_DEFINITION));
							warningcode = '';

							if (mowerDefinitionString.length === 0) {
								warningcode = 'NO_MOWER_DEFINED';
							} else {
								mowerArr = mowerDefinitionString.split(';'); // is encoded
								mowerRunning = false;
								for (let i = 0; i < mowerArr.length; i++) {
									let mow_i = sgDecode(mowerArr[i]);
									if (mow_i === IRRWHILEMOWING_CODE_FORBIDDEN) {
										mowerRunning = true; // per definition
										warningcode = buildWarningcode(warningcode, IRRWHILEMOWING_WARNING_FORBIDDEN);
									} else {
										let sarr = getSaveState(sgEncode(mow_i + '.activity_mowing_i'));
										if (sarr === UNDEFINED) {
											warningcode = buildWarningcode(warningcode, IRRWHILEMOWING_WARNING_UNKNOWN);
										}
										if (sarr === true) {
											mowerRunning = true;
										}
									}
								}

								if (mowerRunning === true) { // stop valve
									if (option === 'EXEC') {
										sgSetStateAck(name + '.duration_value', 'STOP_UNTIL_NEXT_TASK', false); // its a command!
									}
									warningcode = buildWarningcode(warningcode, IRRWHILEMOWING_WARNING_STOPPED);
								}
							}

							if (warningcode !== '') {
								setIrrigationWarning(name, warningcode);
							} else {
								setIrrigationWarning(name, IRRWHILEMOWING_WARNING_NOWARNING);
							}
						} else { // valve open
							setIrrigationWarning(name, IRRWHILEMOWING_WARNING_NOWARNING);
						}
					}
					/* no Error-Reset if Valve was closed
					  else {
						setIrrigationWarning(name, IRRWHILEMOWING_WARNING_NOWARNING);
					} 
					*/
				}
				break;
			case 'MOWER':
				if (a === '.activity_value') {
					mowerRunning = mowerIsMowing(propval);


					if (mowerRunning === true) {
						valvesArr = getSavedServices('SERVICE_VALVE'); // encoded

						// for all valves
						for (let i = 0; i < valvesArr.length; i++) {
							let v_i = sgDecode(valvesArr[i]);
							// valve open?
							if (getSaveState(sgEncode(v_i + '.activity_value')) !== 'CLOSED') {
								// allowed to be open?
								if (getSaveState(sgEncode(v_i + '.' + IRRWHILEMOWING_ALLOWED)) === false) {
									// not allowed for this mower?
									mowerDefinitionString = getSaveState(sgEncode(v_i + '.' + IRRWHILEMOWING_MOWER_DEFINITION));
									warningcode = '';

									if (mowerDefinitionString.length === 0) {
										warningcode = 'NO_MOWER_DEFINED';
									} else {
										mowerArr = mowerDefinitionString.split(';');
										forthismower = false;

										for (let j = 0; j < mowerArr.length; j++) {
											// if valve is not allowed to be open for this mower or
											// its never allowed to be open
											let m_j = mowerArr[j];
											let m_j_d = sgDecode(m_j);
											ju.adapterloginfo('m_j  =' + m_j);
											ju.adapterloginfo('m_j_d=' + m_j_d);

											if (sgDecode(mowerArr[j]) === name) {
												forthismower = true;
												warningcode = buildWarningcode(warningcode, IRRWHILEMOWING_WARNING_STOPPED);
												break;
											} else {
												if (mowerArr[j] === IRRWHILEMOWING_CODE_FORBIDDEN) {
													forthismower = true;
													warningcode = buildWarningcode(warningcode, IRRWHILEMOWING_WARNING_FORBIDDEN);
													break;
												}
											}
										}

										if (forthismower === true) {
											sgSetStateAck(v_i + '.duration_value', 'STOP_UNTIL_NEXT_TASK', false); // its a command!
										}
									}

									if (warningcode !== '') {
										setIrrigationWarning(v_i, warningcode);
									} else {
										setIrrigationWarning(v_i, IRRWHILEMOWING_WARNING_NOWARNING);
									}
								} // allowed to be open?
							} // valve open?
						} // for all valves
					} // mowerRunning
				}
				break;
		}
	}
}

/**
 * handles special states for power socket
 * @param   {string}  name    path of state
 * @param   {string}  a       state
 * @param   {string}  type    message type
 * @param   {object}  propval value
 */
function setPowerSocket(name, a, type, propval) {
}

/**
 * handles special states for sensor
 * @param   {string}  name    path of state
 * @param   {string}  a       state
 * @param   {string}  type    message type
 * @param   {object}  propval value
 */
function setSensor(name, a, type, propval) {
}

/**
 * handles special states for common
 * @param   {string}  name    path of state
 * @param   {string}  a       state
 * @param   {string}  type    message type
 * @param   {object}  propval value
 */
function setCommon(name, a, type, propval) {
}

/**
 * handles leftovertimer
 * @param   {string}  activitytimer  
 * @param   {string}  name    path of state
 * @param   {string}  a       state
 * @param   {string}  type    message type
 * @param   {object}  propval value
 */
function prepLeftoverTimer(activitytimer, name, a, type, propval) {
	// create internal datapoint 'duration_leftover_i'
	// only for VALVE and POWER_SOCKET
	// only if we have 'activity_value' from service
	if (a === '.activity_value') {
		// if device is not switched on for defined time
		// then 
		//        - set internal datapoint 'duration_leftover_i' to 'null'  and
		//        - set datapoint 'duration_timestamp' to ''  and
		//        - set datapoint 'duration_value' to 'null' 
		if (propval !== 'TIME_LIMITED_ON') {
			let defnull = 'null';
			let x1;
			let nx1;
			x1 = '.duration_leftover_i';
			nx1 = name + x1;
			adapter.setObjectNotExists(sgEncode(nx1), {
				type: 'state',
				common: {
					name: x1.substr(1),
					type: 'string',
					role: 'text',
					read: true,
					write: false,
				},
				native: defnull,
			});
			sgSetState(nx1, defnull);

			x1 = '.duration_timestamp';
			nx1 = name + x1;
			adapter.setObjectNotExists(sgEncode(nx1), {
				type: 'state',
				common: {
					name: x1.substr(1),
					type: getPreDefineStateAttribute(type, x1.substr(1), 'type'),
					role: getPreDefineStateAttribute(type, x1.substr(1), 'role'),
					read: true,
					write: getPreDefineStateAttribute(type, x1.substr(1), 'write'),
				},
				native: '',
			});
			sgSetState(nx1, '');

			x1 = '.duration_value';
			nx1 = name + x1;
			adapter.setObjectNotExists(sgEncode(nx1), {
				type: 'state',
				common: {
					name: x1.substr(1),
					type: getPreDefineStateAttribute(type, x1.substr(1), 'type'),
					role: getPreDefineStateAttribute(type, x1.substr(1), 'role'),
					read: true,
					write: getPreDefineStateAttribute(type, x1.substr(1), 'write'),
				},
				native: defnull,
			});
			sgSetState(nx1, defnull);

		}

		// if datapoint 'activity_value' is ... 
		if (propval === 'SCHEDULED_ON' || // power socket
			propval === 'TIME_LIMITED_ON' || // power socket
			propval === 'SCHEDULED_WATERING' || // valve
			propval === 'MANUAL_WATERING') { // valve
			activitytimer.valid = true;
		}
		else // if not then reset variable activitytimer
		{
			activitytimer.valid = false;
			activitytimer.duration = 'null';
			activitytimer.timestamp = 'null';
		}
	}

	// if we have datapoint 'duration_value' then set variable activitytimer
	if (a === '.duration_value') {
		activitytimer.duration = propval;
	}

	// if we have datapoint 'duration_timestamp' then set variable activitytimer
	if (a === '.duration_timestamp') {
		activitytimer.timestamp = propval;
	}

	// if variable activitytimer is set ... then set internal datapoint 'duration_leftover_i' 
	// and start internal timer to realize the drop down counter in 'duration_leftover_i' 
	// 
	if (activitytimer.valid === true && activitytimer.duration !== 'null' && activitytimer.timestamp !== 'null') {
		let x = '.duration_leftover_i';
		let nx = name + x;

		// stop previous leftovertimer; maybe there is none
		deleteLeftoverTimer(nx);

		// because device could be started a long time in the past
		// we compute the actual time difference 
		let curDate = new Date();
		let curDate_ms = curDate.getTime();
		let startDate = new Date(activitytimer.timestamp);
		let endDate_ms = startDate.getTime() + (activitytimer.duration * 1000);

		let difference = endDate_ms - curDate_ms;
		difference = Math.round(difference / 1000 / 60);
		if (difference < 1) {
			difference = 'null';
		}

		adapter.setObjectNotExists(sgEncode(nx), {
			type: 'state',
			common: {
				name: x.substr(1),
				type: 'string',
				role: 'text',
				read: true,
				write: true,
			},
			native: difference,
		});
		sgSetState(nx, difference);

		// if device is running then start internal timer to drop down the 
		// internal datapoint 'duration_leftover_i'
		if (difference !== 'null') {
			let newtimer = setTimeout(setLeftOverTimer, 60 * 1000, nx);
			addLeftoverTimer(nx, newtimer);
		}
	}

}

/**
 * sets forecast state
 * @param   {string}  name    path of state
 * @param   {string}  a       state
 * @param   {string}  type    message type
 * @param   {object}  propval value
 */
function setForecastState(name, a, type, propval) {
	let nx;
	
	if (type === 'COMMON') {
		nx = name + a;
	} else {
		nx = getSaveStateNameWildcard(sgEncode(name),  '-3A*', a);
		nx = sgDecode(nx);
		if (nx === UNDEFINED) {
			ju.adapterloginfo(1, 'setForecastState: undefined name:' + name + '/' + a + '/' + type);
			nx = name + a;
		} 
	}

	adapter.setObjectNotExists(sgEncode(nx), {
		type: 'state',
		common: {
			name: a.substr(1),
			type: 'number',
			role: 'value',
			unit: 'seconds',
			read: true,
			write: false,
		},
		native: propval,
	});
	sgSetState(nx, propval);
}

/**
 * saves forecast history in state
 * @param   {string}  name    path and name of state
 * @param   {object}  propval value
 */
function saveHistory(name, propval) {

	adapter.setObjectNotExists(sgEncode(name), {
		type: 'state',
		common: {
			name: 'saveHistory',
			type: 'string',
			role: 'text',
			read: true,
			write: true,
		},
		native: propval,
	});
	//sgSetState(name, propval); // don't call sgSetState because you get a lot of debug info printed 
	adapter.setState(name, propval, true);

}

/**
 * handles forecasting
 * @param   {string}  name    path of state
 * @param   {string}  a       state
 * @param   {string}  type    message type
 * @param   {object}  propval value
 */
function checkAndSetForecast(name, a, type, propval) {
	let oldval;
	let tname;
	let forecast = {
		mowingValid: false,
		chargingValid: false,
		level: 'null',
		timestamp: 'null'
	};
	let mowHistory;
	let chargeHistory;
	let d;


	if (configUseMowerHistory === false) {
		return;
	}

	// there are only a few types and status relevant for this function
	// check for one of them and return otherwise
	switch (type) {
		case 'COMMON':
			switch (a) {
				case '.batteryLevel_value':
				case '.batteryState_value':
					break;
				default:
					return;
			}
			break;
		case 'MOWER':
			switch (a) {
				case '.activity_value':
				case '.state_value':
					break;
				default:
					return;
			}
			break;
		default:
			return;
	}

	// it is possible that its something else than a mower, maybe a sensor 
	tname = name;
	tname = tname.replace('COMMON', 'MOWER');
	tname = sgEncode(tname);
	if (type === 'COMMON') {
		// its not necessary to encode '.activity_value'
		// '-3A' is ':', but encoded and '*' is the wildcard and shouldn't be encoded
		oldval = getSaveStateWildcard(tname, '-3A*', '.activity_value');
		if (oldval === UNDEFINED) { // check if its a mower and not something else
			ju.adapterloginfo(3, 'forecast: ' + a + ' but no mower');
			return;
		}
	}

	// see above ... its done there
	//tname = name;
	//tname = tname.replace('COMMON', 'MOWER');
	//tname = sgEncode(tname);
	if (!multiMowHistory) {
		multiMowHistory = new Object();
	}
	if (!multiMowHistory.hasOwnProperty(tname)) {
		multiMowHistory[tname] = new HistoryForecast('reverse', configMowerHistoryCycles);
		mowHistory = multiMowHistory[tname];
	} else {
		mowHistory = multiMowHistory[tname];
	}
	if (!multiChargeHistory) {
		multiChargeHistory = new Object();
	}
	if (!multiChargeHistory.hasOwnProperty(tname)) {
		multiChargeHistory[tname] = new HistoryForecast('standard', configMowerHistoryCycles);
		chargeHistory = multiChargeHistory[tname];
	} else {
		chargeHistory = multiChargeHistory[tname];
	}


	if (type === 'COMMON' && a === '.batteryLevel_value') {
		forecast.chargingValid = false;
		forecast.mowingValid = false;
		forecast.level = propval;
		d = new Date();
		forecast.timestamp = d.toISOString();

		// charging or mowing? 
		oldval = getSaveState(sgEncode(name + '.batteryState_value'));
		if (oldval === 'CHARGING') {
			forecast.chargingValid = true;
			forecast.mowingValid = false;
		}
		tname = name.replace('COMMON', 'MOWER');
		// its not necessary to encode '.activity_value'
		// '-3A' is ':', but encoded and '*' is the wildcard and shouldn't be encoded
		oldval = getSaveStateWildcard(sgEncode(tname), '-3A*', '.activity_value');
		if (oldval === 'OK_LEAVING' || oldval === 'OK_CUTTING' || oldval === 'OK_CUTTING_TIMER_OVERRIDDEN') {
			forecast.chargingValid = false;
			forecast.mowingValid = true;
		} else {
			if (oldval === UNDEFINED) { // check if its a mower and not something else
				ju.adapterloginfo(3, 'forecast: ' + a + ' but no mower!');
				forecast.chargingValid = false;
				forecast.mowingValid = false;
			}
		}
	}

	// if mowing
	if (forecast.mowingValid === true && forecast.level !== 'null' && forecast.timestamp !== 'null') {
		tname = name;
		tname = tname.replace('COMMON', 'MOWER');
		let fc = mowHistory.add(forecast.level, forecast.timestamp);
		setForecastState(tname, '.activity_mowingTime_remain_i', type, fc)
		ju.adapterloginfo(3, 'forecast: mowing add level=' + forecast.level + ' timestamp= ' + forecast.timestamp);
		let mowingHistoryString = JSON.stringify(multiMowHistory);
		saveHistory('info.saveMowingHistory', mowingHistoryString);
	}

	// if charging
	if (forecast.chargingValid === true && forecast.level !== 'null' && forecast.timestamp !== 'null') {
		tname = name;
		tname = tname.replace('MOWER', 'COMMON');
		let fc = chargeHistory.add(forecast.level, forecast.timestamp);
		setForecastState(tname, '.batteryState_chargingTime_remain_i', type, fc)
		ju.adapterloginfo(3, 'forecast: charging add level=' + forecast.level + ' timestamp= ' + forecast.timestamp);
		let chargeHistoryString = JSON.stringify(multiChargeHistory);
		saveHistory('info.saveChargingHistory', chargeHistoryString);
	}


	// check for end of mowing
	if (type === 'MOWER' && a === '.activity_value') {
		if (propval !== 'OK_CUTTING' && propval !== 'OK_CUTTING_TIMER_OVERRIDDEN') {
			oldval = getSaveState(sgEncode(name + a));
			if (oldval === 'OK_CUTTING' || oldval === 'OK_CUTTING_TIMER_OVERRIDDEN') {
				// try to recognize mowing end and handle some special cases / errors ???
				// status switches from OK_CUTTING to ...
				switch (propval) {
					case 'OK_SEARCHING': // should be the standard case here
						mowHistory.setEndRecognized();
						ju.adapterloginfo(3, 'forecast: searching station');
						if (mowHistory.shift()) {
							ju.adapterloginfo(3, 'forecast: mowing shift history successful');
						} else {
							ju.adapterloginfo(3, 'forecast: mowing shift history not successful');
						}
						break;
					case 'OK_CHARGING':
						// should never happen here, so we do the same as
						// above, but give a different logmessage to see that this happened
						mowHistory.setEndRecognized();
						if (mowHistory.shift()) {
							ju.adapterloginfo(3, 'forecast: mowing shift history successful/2');
						} else {
							ju.adapterloginfo(3, 'forecast: mowing shift history not successful/2');
						}
						break;
					case 'PAUSED': // special case
					case 'NONE': // special case ; error???
					case 'OK_LEAVING': // this should never happen herre
					case 'PARKED_TIMER': // special case
					case 'PARKED_PARK_SELECTED': // special case
					case 'PARKED_AUTOTIMER': // special case
					default: // there should be no possible further value, but just to be on the safe side
						mowHistory.discard();
						ju.adapterloginfo(1, 'forecast: mowing unexpected end, discard current history: ' + propval);
						break;
				}

				setForecastState(name, '.activity_mowingTime_remain_i', type, '');
				let mowingHistoryString = JSON.stringify(multiMowHistory);
				saveHistory('info.saveMowingHistory', mowingHistoryString);
				ju.adapterloginfo(3, 'forecast: mowing end recognized');
			}
		}
	}

	// check for end charging
	if (type === 'COMMON' && a === '.batteryState_value') {
		if (propval !== 'CHARGING') {
			oldval = getSaveState(sgEncode(name + a));
			if (oldval === 'CHARGING') {
				switch (propval) {
					case 'OK':
						chargeHistory.setEndRecognized();
						ju.adapterloginfo(3, 'forecast: charging end recognized/2');
						if (chargeHistory.shift()) {
							ju.adapterloginfo(3, 'forecast: charging shift history successful');
						} else {
							ju.adapterloginfo(3, 'forecast: charging shift history not successful');
						}
						break;
					default:
						chargeHistory.discard();
						ju.adapterloginfo(1, 'forecast: charging unexpected end, discard current history: ' + propval);
						break;
				}

				setForecastState(name, '.batteryState_chargingTime_remain_i', type, '');
				let chargeHistoryString = JSON.stringify(multiChargeHistory);
				saveHistory('info.saveChargingHistory', chargeHistoryString);
				ju.adapterloginfo(3, 'forecast: charging end recognized');
			}
		}
	}

	// check if we have an error state
	if (type === 'MOWER' && a === '.state_value') {
		if (propval !== 'OK') {
			mowHistory.discard();
			ju.adapterloginfo(1, 'forecast: mowing error recognized, discard current history: ' + propval);
		}
	}
}


/**
 * Setzt die Werte für die States eines Services einer Message vom Garden Smart System
 * Nicht existierende States werden angelegt, existierende ggfs. neu gesetzt.
 * Sonderbehandlung von activity_value=TIME_LIMITED_ON: hier wird der 
 * interne State duration_leftover_i erstellt/aktualisiert
 * Wird aus parseMessage() aufgerufen.
 * @param   {object}  m   message
 */
function setServiceStates(m) {
	let name;
	let a;
	let n;
	let gstates;

	if (m.hasOwnProperty('type') === false) {
		ju.consolelog(1, '### ' + ju.curTime() + ' setServiceStates: no type');
		ju.adapterloginfo(1, 'setServiceStates: no type');	
		return;
	}
	
	if (m.hasOwnProperty('id') === false) {
		ju.consolelog(1, '### ' + ju.curTime() + ' setServiceStates: no id');
		ju.adapterloginfo(1, 'setServiceStates: no id');	
		return;
	}
	
	let activitytimer = {
		valid: false,
		duration: 'null',
		timestamp: 'null'
	};

	// zuerst den richtigen Status=SERVICE ermitteln
	gstates = adapter.getForeignObjects(sgEncode(adapter.name + '.' + adapter.instance + '.*.SERVICE_' + m.type + '_' + m.id), 'channel', function(err, obj) {
		// sollten wir immer haben, da die DEVICEes schon bearbeitet wurden und dort die SERVICEs erstellt werden
		for (name in obj) {
			if (obj.hasOwnProperty(name)) {
				//				ju.consolelog(3, '### ' + ju.curTime() + ' setServiceStates: ' + beautifyStateId(name) + ', Value: ' + obj[name].val);
				//				ju.adapterloginfo(3, 'setServiceStates: ' + name + ', Value: ' + obj[name].val);
				ju.consolelog(3, '### ' + ju.curTime() + ' setServiceStates: ' + beautifyStateId(name));
				ju.adapterloginfo(3, 'setServiceStates: ' + name);

				// name ist encoded, deshalb jetzt decode, damit später die gesamte Id encoded werden kann zum Setzen der states/objects
				name = sgDecode(name);

				for (let propattributes in m) {
					activitytimer.valid = false;
					activitytimer.duration = 'null';
					activitytimer.timestamp = 'null';

					if (propattributes === 'attributes') {
						for (let prop2 in m[propattributes]) {
							for (let prop3 in m[propattributes][prop2]) {
								a = '.' + prop2 + '_' + prop3;
								//n = ln + dn + sn + a;
								n = name + a;

								switch (m.type) {
									case 'MOWER':
										setMower(name, a, m.type, m.attributes[prop2][prop3]);
										checkAndSetForecast(name, a, m.type, m.attributes[prop2][prop3]);
										checkAndSetIrrigationAllowedWhileMowing(name, a, m.type, m.attributes[prop2][prop3])
										break;
									case 'POWER_SOCKET':
										setPowerSocket(name, a, m.type, m.attributes[prop2][prop3]);
										prepLeftoverTimer(activitytimer, name, a, m.type, m.attributes[prop2][prop3]);
										break;
									case 'VALVE':
										setValve(name, a, m.type, m.attributes[prop2][prop3]);
										prepLeftoverTimer(activitytimer, name, a, m.type, m.attributes[prop2][prop3]);
										checkAndSetIrrigationAllowedWhileMowing(name, a, m.type, m.attributes[prop2][prop3])
										break;
									case 'VALVE_SET':
										setValveSet(name, a, m.type, m.attributes[prop2][prop3]);
										break;
									case 'COMMON':
										setCommon(name, a, m.type, m.attributes[prop2][prop3]);
										checkAndSetForecast(name, a, m.type, m.attributes[prop2][prop3]);
										break;
									default:
										break;
								}
								
								let ma_val = checkVal(m.type, a.substr(1), m.attributes[prop2][prop3]);
								adapter.setObjectNotExists(sgEncode(n), {
									type: 'state',
									common: {
										name: a,
										type: getPreDefineStateAttribute(m.type, a.substr(1), 'type'),
										role: getPreDefineStateAttribute(m.type, a.substr(1), 'role'),
										read: true,
										write: getPreDefineStateAttribute(m.type, a.substr(1), 'write'),
									},
									native: JSON.stringify(m.attributes),
								});
								sgSetState(n, ma_val);

							}
						}
					}
				}
			} else {
				ju.consolelog(1, '### ' + ju.curTime() + " setServiceStates: " + name);
			}
		}
	});
}

/*
 * returns value of specific type/role/write of an datapoint in given SERVICE
 * @param: servicetype (string) service name, e.g. 'MOWER' or 'COMMON', ...
 * @param: name 		(string) name(id) of datapoint
 * @param: attr 		(string) returned attribute 'type'|'role'|'write'
 * @return value for attribute
 *
 */
function getPreDefineStateAttribute(servicetype, name, attr) {
	let i;
	let res;

	let dp = gardenaServicesDataPoints;
	let service = 'SERVICE_' + servicetype;

	// set default value for res
	switch (attr) {
		case 'type':
			res = 'string';
			break;
		case 'role':
			res = 'text';
			break;
		case 'write':
			res = true;
			break;
	};

	if (dp.hasOwnProperty(service)) {
		if (dp[service].hasOwnProperty(name)) {
			switch (attr) {
				case 'type':
					res = dp[service][name].commontype;
					break;
				case 'role':
					res = dp[service][name].commonrole;
					break;
				case 'write':
					res = dp[service][name].commonwrite;
					break;
			}
		}
	}

	return res;
}

/*
 * creates datapoints for a given SERVICE
 * @param: id (string)              id under which datapoint is created
 * @param: type (string)            service name, e.g. 'MOWER' or 'COMMON', ...
 * @param: maindevicetype (string)  only relavant if type='COMMON' 
 *                                  describes the main service for the COMMON service, e.g. 'MOWER' 
 */
function sgPreDefineStates(id, type, maindevicetype) {
	let i;
	let name;
	let dp;
	let service;

	if (adapter.config.preDefineStates === true) {
		dp = gardenaServicesDataPoints;
		service = 'SERVICE_' + type;

		if (type !== 'COMMON') {
			maindevicetype = type;
		};

		if (dp.hasOwnProperty(service)) {
			for (name in dp[service]) {
				if (dp[service][name].predefineForDevices.indexOf(maindevicetype) >= 0) {
					adapter.setObjectNotExists(sgEncode(id + '.' + name), {
						type: 'state',
						common: {
							name: name,
							type: dp[service][name].commontype,
							role: dp[service][name].commonrole,
							read: true,
							read: true,
							write: dp[service][name].commonwrite
						},
						native: 'predefined state',
					});
				}
			}
		}
	}
}

/*
 * checks and corrects format of the value for dates and numbers 
 * in an datapoint in given SERVICE
 * @param: servicetype (string) service name, e.g. 'MOWER' or 'COMMON', ...
 * @param: name        (string) name(id) of datapoint
 * @param: val         (string) checked value
 * @return checked and maybe corrected value for attribute
 */
function checkVal(servicetype, name, val) {
	let commontype = getPreDefineStateAttribute(servicetype, name, 'type');
	let commonrole = getPreDefineStateAttribute(servicetype, name, 'role');
	
/*
	lastErrorCode_timestamp: {predefineForDevices: ['MOWER'],
				commontype: 'string',
				commonrole: 'date',
				unit: 'none',
				iscommand: false,
				commonwrite: false},
	operatingHours_value: {predefineForDevices: ['MOWER'],
				commontype: 'number',
				commonrole: 'value',
				unit: 'none',
				iscommand: false,
				commonwrite: false}										
*/

	if (commontype === 'string' && commonrole === 'date') {
		let d;
		let dt = isValidDate(val);
		if (dt === -2) {
			ju.adapterloginfo(1, 'checkVal: invalid date: ' + val + ' / ' + servicetype + ' / ' + name);
			d = new Date(unixTimeZero); // unix time zero
		} else {
			if (dt === -1) {
				d = new Date(val);
			} else {
				d = new Date(dt);
			}
		}
		return d.toISOString();
	}
	
	if (commontype === 'number') {
		let n = parseInt(val);
		if (n === NaN) {
			ju.adapterloginfo(1, 'checkVal: NaN: ' + val + ' / ' + servicetype + ' / ' + name );
			n = -1;
		}
		return n;
	}
	
	return val;
}

/**
 * Setzt die Werte für LOCATIONS und DEVICES aus einer Message vom Gardena Smart System als states,
 * für alle anderen SERVICES wird setServiceStates() aufgerufen.
 * Nicht existierende States werden angelegt, existierende ggfs. neu gesetzt.
 * @param   {object}  msg   message
 */
function parseMessage(msg) {
	//let ln;
	//let dn;
	//let sn;
	//let a;
	//let n;
	let maindevicetype;
	let commonid;

	if (msg.hasOwnProperty('data') === false) {
		ju.consolelog(1, '### ' + ju.curTime() + ' parseMessage: no data');
		ju.adapterloginfo(1, 'parseMessage: no data');	
		return;
	}
	let m = JSON.parse(msg.data);
	
	if (m.hasOwnProperty('type') === false) {
		ju.consolelog(1, '### ' + ju.curTime() + ' parseMessage: no type');
		ju.adapterloginfo(1, 'parseMessage: no type');	
		return;
	}
	
	if (m.hasOwnProperty('id') === false) {
		ju.consolelog(1, '### ' + ju.curTime() + ' parseMessage: no id');
		ju.adapterloginfo(1, 'parseMessage: no id');	
		return;
	}
	
	switch (m.type) {
		case "LOCATION":
			ju.consolelog(2, '### ' + ju.curTime() + ' parseMessage: LOCATION found');
			ju.adapterloginfo(2, 'parseMessage: LOCATION found');
			//mylocationobjectname = 'LOCATION_' + m.id;
			adapter.setObjectNotExists(sgEncode('LOCATION_' + m.id), {
				type: 'folder',
				common: {
					name: 'LOCATION_' + m.id,
					type: 'string',
					role: 'text',
					read: true,
					write: false,
				},
				native: msg.data,
			});
			//sgSetState('LOCATION_' + m.id, m.type); //'LOCATION'

			if (m.hasOwnProperty('attributes') === false) {
				ju.consolelog(1, '### ' + ju.curTime() + ' parseMessage: no attributes');
				ju.adapterloginfo(1, 'parseMessage: no attributes');	
				return;
			}
	
			if (m.attributes.hasOwnProperty('name') === false) {
				ju.consolelog(1, '### ' + ju.curTime() + ' parseMessage: no attributes.name');
				ju.adapterloginfo(1, 'parseMessage: no attributes.name');	
				return;
			}
	
			adapter.setObjectNotExists(sgEncode('LOCATION_' + m.id + '.name'), {
				type: 'state',
				common: {
					name: 'LOCATION_' + m.id + '.name',
					type: 'string',
					role: 'info.name',
					read: true,
					write: false,
				},
				native: JSON.stringify(m.attributes),
			});
			sgSetState('LOCATION_' + m.id + '.name',
				m.attributes.name); //'DEVICE'

			if (m.hasOwnProperty('relationships') === false) {
				ju.consolelog(1, '### ' + ju.curTime() + ' parseMessage: no relationships');
				ju.adapterloginfo(1, 'parseMessage: no relationships');	
				return;
			}

			if (m.relationships.hasOwnProperty('devices') === false) {
				ju.consolelog(1, '### ' + ju.curTime() + ' parseMessage: no relationships.devices');
				ju.adapterloginfo(1, 'parseMessage: no relationships.devices');	
				return;
			}

			if (m.relationships.devices.hasOwnProperty('data') === false) {
				ju.consolelog(1, '### ' + ju.curTime() + ' parseMessage: no relationships.devices.data');
				ju.adapterloginfo(1, 'parseMessage: no relationships.devices.data');	
				return;
			}

			for (let i = 0; i < m.relationships.devices.data.length; i++) {
				if (m.relationships.devices.data[i].hasOwnProperty('id') === false) {
					ju.consolelog(1, '### ' + ju.curTime() + ' parseMessage: no relationships.devices.data[' + i + '].id');
					ju.adapterloginfo(1, 'parseMessage: no relationships.devices.data[' + i + '].id');	
					return;
				}

				adapter.setObjectNotExists(sgEncode('LOCATION_' + m.id + '.DEVICE_' + m.relationships.devices.data[i].id), {
					type: 'device',
					common: {
						name: 'DEVICE_' + m.relationships.devices.data[i].id,
						type: 'string',
						role: 'text',
						read: true,
						write: false,
					},
					native: JSON.stringify(m.relationships.devices.data[i]),
				});
				//sgSetState('LOCATION_' + m.id + '.DEVICE_' + m.relationships.devices.data[i].id, 
				//                       m.relationships.devices.data[i].type); //'DEVICE'
			}
			break;
		case "DEVICE":
			ju.consolelog(2, '### ' + ju.curTime() + ' parseMessage: DEVICE found');
			ju.adapterloginfo(2, 'parseMessage: DEVICE found');

			if (m.hasOwnProperty('relationships') === false) {
				ju.consolelog(1, '### ' + ju.curTime() + ' parseMessage: no relationships');
				ju.adapterloginfo(1, 'parseMessage: no relationships');	
				return;
			}

			if (m.relationships.hasOwnProperty('location') === false) {
				ju.consolelog(1, '### ' + ju.curTime() + ' parseMessage: no relationships.location');
				ju.adapterloginfo(1, 'parseMessage: no relationships.location');	
				return;
			}

			if (m.relationships.location.hasOwnProperty('data') === false) {
				ju.consolelog(1, '### ' + ju.curTime() + ' parseMessage: no relationships.location.data');
				ju.adapterloginfo(1, 'parseMessage: no relationships.location.data');	
				return;
			}
			
			if (m.relationships.location.data.hasOwnProperty('id') === false) {
				ju.consolelog(1, '### ' + ju.curTime() + ' parseMessage: no relationships.location.data.id');
				ju.adapterloginfo(1, 'parseMessage: no relationships.location.data.id');	
				return;
			}
			
			if (m.relationships.hasOwnProperty('services') === false) {
				ju.consolelog(1, '### ' + ju.curTime() + ' parseMessage: no relationships.services');
				ju.adapterloginfo(1, 'parseMessage: no relationships.services');	
				return;
			}

			if (m.relationships.services.hasOwnProperty('data') === false) {
				ju.consolelog(1, '### ' + ju.curTime() + ' parseMessage: no relationships.services.data');
				ju.adapterloginfo(1, 'parseMessage: no relationships.services.data');	
				return;
			}
			
			for (let i = 0; i < m.relationships.services.data.length; i++) {
				let ln = 'LOCATION_' + m.relationships.location.data.id;
				let dn = '.DEVICE_' + m.id;
				
				if (m.relationships.services.data[i].hasOwnProperty('type') === false) {
					ju.consolelog(1, '### ' + ju.curTime() + ' parseMessage: no relationships.services.data[' + i + '].type');
					ju.adapterloginfo(1, 'parseMessage: no relationships.services.data[' + i + '].type');	
					return;
				}
				if (m.relationships.services.data[i].hasOwnProperty('id') === false) {
					ju.consolelog(1, '### ' + ju.curTime() + ' parseMessage: no relationships.services.data[' + i + '].id');
					ju.adapterloginfo(1, 'parseMessage: no relationships.services.data[' + i + '].id');	
					return;
				}
				let sn = '.SERVICE_' + m.relationships.services.data[i].type + '_' + m.relationships.services.data[i].id;
				let n = ln + dn + sn;

				adapter.setObjectNotExists(sgEncode(n), {
					type: 'channel',
					common: {
						name: sn.substr(1), // discard the point '.' at the beginning
						type: 'string',
						role: 'text',
						read: true,
						write: false,
					},
					native: JSON.stringify(m.relationships.services),
				});
				//sgSetState(n, m.relationships.services.data[i].type); 	
				if (m.relationships.services.data[i].type !== 'COMMON') { // COMMON needs some special handling and you need the "real" device type for that
					maindevicetype = m.relationships.services.data[i].type;
					sgPreDefineStates(n, maindevicetype, '');
				} else {
					commonid = n;
				}
			}
			sgPreDefineStates(commonid, 'COMMON', maindevicetype);
			maindevicetype = '';
			break;
		case "POWER_SOCKET":
			ju.consolelog(2, '### ' + ju.curTime() + ' parseMessage: POWER_SOCKET found');
			ju.adapterloginfo(2, 'parseMessage: POWER_SOCKET found');
			setServiceStates(m);
			break;
		case "COMMON":
			ju.consolelog(2, '### ' + ju.curTime() + ' parseMessage: COMMON found');
			ju.adapterloginfo(2, 'parseMessage: COMMON found');
			setServiceStates(m);
			break;
		case "VALVE_SET":
			ju.consolelog(2, '### ' + ju.curTime() + ' parseMessage: VALVE_SET found');
			ju.adapterloginfo(2, 'parseMessage: VALVE_SET found');
			setServiceStates(m);
			break;
		case "VALVE":
			ju.consolelog(2, '### ' + ju.curTime() + ' parseMessage: VALVE found');
			ju.adapterloginfo(2, 'parseMessage: VALVE found');
			setServiceStates(m);
			break;
		case "MOWER":
			ju.consolelog(2, '### ' + ju.curTime() + ' parseMessage: MOWER found');
			ju.adapterloginfo(2, 'parseMessage: MOWER found');
			setServiceStates(m);
			break;
		case "SENSOR":
			ju.consolelog(2, '### ' + ju.curTime() + ' parseMessage: SENSOR found');
			ju.adapterloginfo(2, 'parseMessage: SENSOR found');
			setServiceStates(m);
			break;
		default:
			ju.consolelog(1, '### ' + ju.curTime() + ' parseMessage: Unknown message/device found');
			ju.adapterloginfo(1, 'parseMessage: Unknown message/device found');
			break;
	}
}

/*
 * Eventhandler für Websocket 
 */
class Client {
	on_message(message) {
		ju.consolelog(3, '### ' + ju.curTime() + " on_message: ", message);
		parseMessage(message);
	}
	on_error(error) {
		ju.consolelog(1, '### ' + ju.curTime() + " on_error: error=", error);
	}
	on_close(close) {
		let t = 'on_close: ### closed ### close.code=' + close.code + ' close.reason=' + close.reason;
		ju.consolelog(1, '### ' + ju.curTime() + " " + t);
		ju.adapterloginfo(1, t);

		if (heartbeat_interval !== null) {
			clearInterval(heartbeat_interval);
			heartbeat_interval = null;
		}
		sgSetState('info.connection', false);
		websocketclient = null;
	}
	on_open() {
		let t = "on_open: ### connected ###";
		ju.consolelog(1, '### ' + ju.curTime() + " " + t);
		ju.adapterloginfo(1, t);

		if (heartbeat_interval !== null) {
			clearInterval(heartbeat_interval);
			heartbeat_interval = null;
		}

		missed_heartbeats = 0;
		heartbeat_interval = setInterval(function() {
			try {
				missed_heartbeats++;
				if (missed_heartbeats >= max_missed_heartbeats) throw new Error("Too many missed heartbeats.");
				ju.consolelog(1, '### ' + ju.curTime() + " ++ ping ++"); // +" "+JSON.stringify(websocketclient));
				websocketclient.ping();
			} catch (e) {
				clearInterval(heartbeat_interval);
				heartbeat_interval = null;
				console.warn(ju.curTime() + " ++ Closing connection. Reason: " + e.message);
				ju.consolelog(1, "++ Closing connection. Reason: " + e.message);
				ju.adapterloginfo(1, "++ Closing connection. Reason: " + e.message);
				websocketclient.close();
			}
		}, gardena_ping_frequence * 1000);
	}

	on_ping() {
		let t = "on_ping: ++ ping'ed ++";
		ju.consolelog(2, '### ' + ju.curTime() + " " + t);
		ju.adapterloginfo(2, t);
	}

	on_pong() {
		let t = "on_pong: ++ pong'ed ++";
		ju.consolelog(2, '### ' + ju.curTime() + " " + t);
		ju.adapterloginfo(2, t);

		missed_heartbeats = 0;

		// toggle testVariable
		if (configUseTestVariable === true) {
			let b = adapter.getState(sgEncode('testVariable'), function(err, state) {
				ju.adapterloginfo(1,
					'State ' + adapter.namespace + '.testVariable -' +
					'  Value: ' + state.val +
					', ack: ' + state.ack +
					', time stamp: ' + state.ts +
					', last changed: ' + state.lc
				);
				sgSetState('testVariable', !state.val);
			});
		}
	}
}

/**
 * Setzt Variable für den Adapter in diesem Modul
 * @param   {object}  adapter_in   adapter object
 */
exports.setAdapter = function(adapter_in) {
	adapter = adapter_in;

	configUseTestVariable = adapter.config.useTestVariable;

	configUseMowerHistory = adapter.config.useMowerHistory;
	configMowerHistoryCycles = adapter.config.MowerHistoryCycles;
	configMowerHistoryCycles = parseInt(configMowerHistoryCycles);
	if (isNaN(configMowerHistoryCycles)) {
		configMowerHistoryCycles = minMowerHistoryCycles;
	}
	if (configMowerHistoryCycles < minMowerHistoryCycles) {
		configMowerHistoryCycles = minMowerHistoryCycles;
	}
	configMowerHistoryCycles = configMowerHistoryCycles + 1; // we need 1 additional array for current values

	configUseIrrigationAllowedWhileMowing = adapter.config.useIrrigationAllowedWhileMowing;

	ju.init(adapter);
};



exports.setMowingHistory = function(h) {
	let name;
	if (!multiMowHistory) {
		multiMowHistory = new Object();
	}
	for (name in h) {
		multiMowHistory[name] = new HistoryForecast('reverse', configMowerHistoryCycles, h[name]);
	}
}

exports.setChargingHistory = function(h) {
	let name;
	if (!multiChargeHistory) {
		multiChargeHistory = new Object();
	}
	for (name in h) {
		multiChargeHistory[name] = new HistoryForecast('standard', configMowerHistoryCycles, h[name]);
	}
}

/**
 * Schreibt die Revisions von Main und API in einen DP
 * 
 * @param   {string}  mainrev  Revision von Main im Format $Rev: 2133 $
 */
exports.setVer = function(mainrev) {
	let id = 'info.revision';
	let rev = 'Main: ' + mainrev.substr(6, mainrev.length - 6 - 2) + ' / API: ' + apirev.substr(6, apirev.length - 6 - 2);
	adapter.setObjectNotExists(id, {
		type: 'state',
		common: {
			name: id,
			type: 'string',
			role: 'text',
			read: true,
			write: false,
		},
		native: rev,
	});
	sgSetState(id, rev);
};

/**
 * Connect to Gardena smart system using username and password
 */
exports.connect = function(callback) {
    let gardena_authentication_host = adapter.config.gardena_authentication_host.trim();
	let gardena_authtoken_factor = adapter.config.gardena_authtoken_factor;
    let gardena_username = adapter.config.gardena_username.trim();
    let gardena_password = adapter.config.gardena_password.trim();
	
	gardena_smart_host = adapter.config.smart_host.trim();
    gardena_api_key = adapter.config.gardena_api_key.trim();
    gardena_ping_frequence = adapter.config.gardena_ping_frequence;
  
	ju.adapterloginfo(1, "Gardena Smart System Service hosts at: smart_host: " + gardena_smart_host + " authentication_host: " + gardena_authentication_host);
	
	if (gardena_username.length === 0) {
		ju.adapterloginfo(1, 'connect ... empty username');
		ju.consolelog(1, 'connect ... empty username');
	}
	if (gardena_password.length === 0) {
		ju.adapterloginfo(1, 'connect ... empty password');
		ju.consolelog(1, 'connect ... empty password');
	}
	if (gardena_api_key.length === 0) {
		ju.adapterloginfo(1, 'connect ... empty api key');
		ju.consolelog(1, 'connect ... empty api key');
	}
	//ju.adapterloginfo(1, "Gardena Smart System Service hosts at: smart_host: " + gardena_smart_host + " authentication_host: " + gardena_authentication_host + " / api_key: " + gardena_api_key + ".");
	//ju.adapterloginfo(1, "Connecting to Gardena Smart System Service credentials: user: " + gardena_username + " password: " + gardena_password + ".");
	
	let options_connect = {
		url: gardena_authentication_host + '/v1/oauth2/token',
		method: 'POST',
		json: true,
		headers: {
			'accept': 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		form: {
			'grant_type': 'password', 
	        'username': gardena_username, 
			'password': gardena_password, 
			'client_id': gardena_api_key
		}
	};

	request(options_connect, function(err, response, body){
		if(err || !response || response.statusCode >= 300) {
			// no connection or auth failure
			sgSetState('info.connection', false);
			
			if (err) {
				ju.adapterloginfo(1, err);
				if(callback) callback(err);
			};
			if (response) {
				ju.adapterloginfo(1, 'Connection failure.' + JSON.stringify(response.body));
				if(callback) callback(new Error(response.statusCode), response.body);
			}

			
		} else {
			// connection successful
			ju.adapterloginfo(1, 'Connection: successful: response.statusCode / statusMessage=' + response.statusCode + ' / ' + response.statusMessage);
			auth = response.body.access_token;
			PostOAuth2Response = response.body;
			gardena_refresh_token = response.body.refresh_token;
			sgSetState('info.connection', true);
			
			if (refresh_timer !== null) {
				clearTimeout(refresh_timer);
				refresh_timer = null;
			}
			let timeout = Math.round(response.body.expires_in * gardena_authtoken_factor);
			refresh_timer = setTimeout(reconnectWithRefreshToken, timeout*1000);
			
			if(callback) callback(err, auth);
		}
    })
};

/**
 * Ermittelt die LOCATIONS des Gardena smart systems
 */
exports.get_locations = function(callback) {
	let parsed_locations;

	let options_getlocations = {
		url: gardena_smart_host + '/v1/locations',
		method: 'GET',
		headers: {
			'Authorization': 'Bearer ' + auth,
			'Authorization-Provider': 'husqvarna',
			'X-Api-Key': gardena_api_key
		}
	};

	ju.adapterloginfo(1, "get_locations ...");

	request(options_getlocations, function(err, response, body) {
		if (err || !response) {
			// no connection or auth failure
			adapter.log.error(err);
			ju.adapterloginfo(1, 'get_locations failure.');
			sgSetState('info.connection', false);
			locations = {};

			if (callback) callback(err, locations);
		} else {
			// connection successful
			// check that we dont have something like {"message":"Missing Authentication Token"}
			if (response.hasOwnProperty('body')) {
				locations = response.body;
				parsed_locations = JSON.parse(locations);
				if (parsed_locations.hasOwnProperty('data')) {
					if (parsed_locations.data.length >= 1) {
						ju.adapterloginfo(1, 'get_locations: successful / response.statusMessage: ' + response.statusMessage);

						// "{"data":[{"id":"139c1da4-cc23-4f99-839a-b1ac654909cf","type":"LOCATION","attributes":{"name":"My Garden"}}]}"
						locationid = parsed_locations.data[0].id

						if (callback) callback(err, locations);
					} else {
						if (callback) callback(new Error('getlocations: data.length=' + response.body.data.length));
					}
				} else {
					if (callback) callback(new Error('getlocations: no data'));
				}
			} else {
				if (callback) callback(new Error('getlocations: no body'));
			}
		}
	})
};

/**
 * Erzeugt eine Websocket Schnittstelle zum Gardena smart systems
 */
exports.get_websocket = function(callback) {
	let options_get_websocket = {
		url: gardena_smart_host + '/v1/websocket',
		method: 'POST',
		json: {
			data: {
				'type': 'WEBSOCKET',
				'attributes': {
					'locationId': locationid
				},
				'id': 'does-not-matter'
			}
		},
		headers: {
			'accept': 'application/vnd.api+json',
			'Content-Type': 'application/vnd.api+json',
			'Authorization': 'Bearer ' + auth,
			'Authorization-Provider': 'husqvarna',
			'X-Api-Key': gardena_api_key
		}
	};

	ju.adapterloginfo(1, "get_websocket ...");

	request(options_get_websocket, function(err, response, body) {
		//"{"errors":[{"id":"2f73193c-0859-4ddd-9d8a-1c6b298dbbd9","status":"INVALID_LOCATION_ID","code":"400","title":"invalid location id","detail":"The location ID can not be parsed."}]}"
		//"{"data":{"type":"WEBSOCKET","attributes":{"locationId":"185b1234-cd2a-4f99-759a-b16c124347cf"},"id":"does-not-matter"}}"
		if (err || !response || response.statusCode >= 300) {
			// no connection or auth failure
			adapter.log.error(err);
			ju.adapterloginfo(1, 'get_websocket failure.');
			sgSetState('info.connection', false);
			if (err) {
				websocketresp = {};
				if (callback) callback(err, websocketresp);
			} else {
				if (response) {
					if (response.statusCode >= 300) {
						ju.adapterloginfo(1, 'get_websocket failure: response.statusCode/Message=' + response.statusCode + '/' + response.statusMessage);
						if (callback) callback(err, response);
					}
				}
			}
		} else {
			// connection successful
			ju.adapterloginfo(1, 'get_websocket successful: response.statusCode/Message=' + response.statusCode + '/' + response.statusMessage);
			websocketresp = response.body;
			websocketurl = websocketresp.data.attributes.url;

			websocketclient = new websocket(websocketurl);

			client = new Client();
			websocketclient.onopen = client.on_open;
			websocketclient.onmessage = client.on_message;
			websocketclient.onerror = client.on_error;
			websocketclient.onclose = client.on_close;

			websocketclient.addEventListener('ping', client.on_ping);
			websocketclient.addEventListener('pong', client.on_pong);

			if (callback) callback(err, websocketurl);
		}
	})
};