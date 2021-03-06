const EventEmitter = require('events');
const discordjs = require('discord.js');
const HelpCmd = require('./helpcmd');
const consts = require('./const');
const Command = require('./command');
const DatabaseInterface = require('./dbinterface');
const DefaultPermissionHandler = require('./defpermhandler');
const PermissionInterface = require('./perminterface');
const LoggerContainer = require('./loggercontainer');


class CmdHandler extends EventEmitter {

    ///// PUBLICS /////

    /**
     * Create instance of Cmdhandler.
     * @public
     * @param {Object}  client                     discord.js client instance
     * @param {Object}  options                    Options for the CommandHandler
     * @param {string}  options.prefix             Default prefix to access bot. This prefix is ALWAYS ACTIVE and will
     *                                             not be overwritten by guild prefixes.
     * @param {string}  [options.botOwnerID]       The ID of the owner of this bot. This user will automatically get FULL PERMISSION for ALL commands!     
     * @param {number}  [options.ownerPermLvl]     Guild owner permission level (default: 10)
     * @param {number}  [options.defaultColor]     Default color used for output message embeds
     * @param {boolean} [options.useDefaultLogger] If you do not want to use the default winston logger in addition to other registered loggers, set this
     *                                             to 'false' (default: true)
     * @param {boolean} [options.logToConsole]     Wether log command executions to console or not (default: true)
     * @param {boolean} [options.verboseLog]       Enabel or disable verbose logging (default: false)  
     * @param {boolean} [options.invokeToLower]    Wether invoke should be always lowercased or not (default: true)
     * @param {boolean} [options.parseMsgEdit]     Wether or not the command parser should interprete edited messages
     *                                             as command executions or not (default: true)
     * @param {boolean} [options.parseDM]          Wether or not the bot should parse commands in DMs generally (default: false) 
     */
    constructor(client, options) {
        super();
        if (!client) {
            throw Error('Client undefined or not initialized');
        }
        if (!options) {
            throw Error('options undefined');
        }
        if (!options.prefix) {
            throw Error('options.prefix not defined');
        }

        this.client = client;

        this.registeredCommands = {};
        this.registeredCommandInstancesSingle = [];
        this.guildPrefixes = {};

        this.useDefaultLogger = options.useDefaultLogger ? options.useDefaultLogger : true;
        this.logger = new LoggerContainer(this.useDefaultLogger);

        this.prefix = options.prefix;
        this.botOwner = options.botOwnerID;
        this.ownerPermLvl = options.ownerPermLvl || 10;
        this.logToConsole = options.logToConsole ? options.logToConsole : true;
        this.verboseLog = options.verboseLog ? options.verboseLog : false;
        this.invokeToLower = options.invokeToLower ? options.invokeToLower : true;
        this.parseMsgEdit = options.parseMsgEdit ? options.parseMsgEdit : true;
        this.parseDM = options.parseDM ? options.parseDM : false;
        if (options.defaultColor) {
            consts.COLORS.DEFAULT = options.defaultColor;
        }

        this._defaultHelpCmdInstance = new HelpCmd();
        this._permissionHandlerClass = DefaultPermissionHandler;

        client.on('ready', () => {
            this._setup();
        });
    }

    /**
     * Register used database driver class. Must extend DatabaseInterface.
     * @public
     * @param {Object} DatabaseDriverClass Class of the used database driver (must extend DatabaseInterface)
     * @returns this
     */
    setDatabaseDriver(DatabaseDriverClass) {
        if (!DatabaseDriverClass) {
            throw Error('database driver is undefined!');
        }
        if (!(DatabaseDriverClass.prototype instanceof DatabaseInterface)) {
            throw Error('database driver must extend DatabaseInterface!');
        }
        this.databaseDriver = new DatabaseDriverClass();
        return this;
    }

    /**
     * Register a custom permission handler class for command
     * permission instead of default permission level based system.
     * Must extend PermissionInstance.
     * @public
     * @param {Object} PermissionHandlerClass Class of used permission handler (must extend PermissionInstance)
     */
    setPermissionHandler(PermissionHandlerClass) {
        if (!PermissionHandlerClass) {
            throw Error('permission handler class is undefined!');
        }
        if (!(PermissionHandlerClass.prototype instanceof PermissionInterface)) {
            throw Error('permission handler must extend PermissionInterface!');
        }
        this._permissionHandlerClass = PermissionHandlerClass; 
        return this;
    }

    /**
     * Register a command Class.
     * @public
     * @param {Object} CommandClass Class of the Command (not an instance!)
     * @param {string} [commandGroup] Commands group (defaultly 'MISC') 
     * @returns {Object} this
     */
    registerCommand(CommandClass, commandGroup) {
        if (CommandClass.prototype instanceof Command) {
            var commandInstance = new CommandClass();
            commandInstance
                ._setClient(this.client)
                ._setGroup(commandGroup ? commandGroup.toUpperCase() : CmdHandler.DEFAULT_GROUPS.MISC);
            if (Array.isArray(commandInstance.invokes)) {
                commandInstance.invokes.forEach((invoke) => {
                    this.registeredCommands[invoke] = commandInstance;
                })
            } else {
                this.registeredCommands[commandInstance.invokes] = commandInstance;
            }
            this.registeredCommandInstancesSingle.push(commandInstance);
        } else {
            throw Error('Class needs to extend Command class to be registered as command');
        }
        return this;
    }

    /**
     * Register a new logger. Must extend LoggerInterface.
     * @public
     * @param {string} name              Name of the logger
     * @param {Object} LoggerClass       Class object of the logger
     * @param {number} [defaultLogLevel] Default log level (default: 0) 
     */
    registerLogger(name, LoggerClass, defaultLogLevel) {
        this.logger.registerLogger(name, LoggerClass, defaultLogLevel);
        return this;
    }

    /**
     * Get a registered logger instance by name.
     * @public
     * @param {string} name Registered name of the logger
     * @returns {Object} Logger instance
     */
    getLoggerByName(name) {
        return this.logger.getLoggerByName(name);
    }

    ///// PUBLIC STATICS /////

    /**
     * Default command groups enum.
     * @public
     */
    static get DEFAULT_GROUPS() {
        return {
            MISC:       'MISC',
            ADMIN:      'ADMIN',
            MODERATIVE: 'MODERATIVE',
            FUN:        'FUN',
            CHAT:       'CHAT',
            GAMES:      'GAMES',
            INFO:       'INFO'
        };
    }

    ///// PRIVATES /////

    /**
     * Will be executed if discord.js client is ready.
     * @private
     */
    _setup() {
        if (!this.botOwner) {
            this.logger.warning('No bot owner set! If you are the owner / host of this bot, please set your ID as bot owner for full permission to all commands!');
        }
        this.permissionHandler = new this._permissionHandlerClass(this.databaseDriver);
        this._registerMessageHandler();
    }

    /**
     * Registers message handlers for ingoing messages and
     * message edits, if activated in options.
     * @private
     */
    _registerMessageHandler() {
        this.client.on('message', (message) => {
            this._parseCommand(message)
        });
        if (this.parseMsgEdit) {
            this.client.on('messageUpdate', (_, newMessage) => {
               this. _parseCommand(newMessage);
            });
        }
        this.logger.info(`Registered ${this.registeredCommandInstancesSingle.length} commands`);
    }

    /**
     * Creates command argument object from message object and
     * arguments.
     * @private
     */
    _assembleCommandArgsPayload(message, args) {
        return {
            channel:    message.channel,
            member:     message.member,
            guild:      message.member ? message.member.guild : null,
            message:    message,
            args:       args,
            cmdhandler: this,
        };
    }

    _commandFailed(cmdinstance, message, cmdArgs, err) {
        if (this.logToConsole) {
            this.logger.error(`<CMD FAILED> {${message.author.tag}@${message.member ? message.member.guild.name : 'DM'}} ${message.content}`);
        }
        try {
            cmdinstance.error(err, cmdArgs);
        } catch (err) {
            this.logger.error(`|${cmdinstance.mainInvoke}| failed executing commands error() function: ` + err);
        }
    }

    /**
     * Executes a command from CmdInstance
     * @private
     */
    _execCommand(cmdinstance, message, cmdArgs) {
        this.permissionHandler.checkUserPermission(cmdArgs, cmdinstance).then((permitted) => {
            if (permitted || (this.botOwner && cmdArgs.author.id == this.botOwner)) {
                new Promise((resolve, reject) => {
                    cmdinstance.exec(cmdArgs);
                    resolve();
                }).then(() => {
                    if (this.logToConsole) {
                        this.logger.info(`<CMD EXEC> {${message.author.tag}@${message.member ? message.member.guild.name : 'DM'}} ${message.content}`);
                    }
                }).catch((err) => {
                    this._commandFailed(cmdinstance, message, cmdArgs, err)
                });;
            } else {
                this._commandFailed(cmdinstance, message, cmdArgs, Error('Missing permission.'))
            }
        }).catch((err) => {
            this.logger.error('Permission check failed:', err);
        })
    }

    /**
     * Handle function for message and edit event to check if
     * a command should be executed.
     * @private
     */
    _parseCommand(message) {
        if (!message || message.author == this.client.user || message.author.bot) {
            return;
        }
        if (message.channel.type == 'dm' && !this.parseDM) {
            return;
        }

        let member = message.member || message.author;
        let guild = message.member ? message.member.guild : null;

        let _cont = message.content;

        new Promise((resolve, reject) => {
            if (guild) {
                let guildPrefix;
                this.databaseDriver.getGuildPrefix(guild.id).then((prefix) => {
                    guildPrefix = prefix;
                }).catch(() => {
                }).finally(() => {
                    resolve(guildPrefix);
                });
            }
        }).then((guildPrefix) => {
            let _defPreUsed = _cont.startsWith(this.prefix);
            let _guildPreUsed = (guildPrefix && _cont.startsWith(guildPrefix))
            if (_defPreUsed || _guildPreUsed) {
                let invoke = _cont
                    .split(/\s+/g)[0]
                    .substr(_defPreUsed ? this.prefix.length : guildPrefix.length);
                
                if (this.invokeToLower) {
                    invoke = invoke.toLowerCase();
                }

                let args = _cont
                    .split(/\s+/g)
                    .slice(1);
            
                if (Object.keys(this.registeredCommands).includes(invoke)) {
                    let cmdArgs = this._assembleCommandArgsPayload(message, args);
                    let cmdinstance = this.registeredCommands[invoke];
                    this._execCommand(cmdinstance, message, cmdArgs);
                } else if (invoke == 'help') {
                    let cmdArgs = this._assembleCommandArgsPayload(message, args);
                    this._execCommand(this._defaultHelpCmdInstance, message, cmdArgs);
                }
            }
        });
    }
}

module.exports = CmdHandler;