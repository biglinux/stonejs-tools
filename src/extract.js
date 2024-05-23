"use strict";

var fs = require("fs");
var async = require("async");
var glob = require("glob");
var espree = require("espree");
var gettextParser = require("gettext-parser");
var cheerio = require("cheerio");

var helpers = require("./helpers.js");

/**
 * @class extract
 * @constructor
 */
var extract = {};

/**
 * Run all the string extraction process (list files, read files, extract string, generate po template, write po template).
 *
 * options:
 *
 *     {
 *         'functions': ["_", "gettext", "lazyGettext"],   // The name of the gettext functions
 *         'pluralFunctions': ["ngettext", "lazyNgettext"],   // The name of the ngettext functions
 *         'contextFunctions': ["pgettext", "lazyPgettext"],   // The name of the pgettext functions
 *         'pluralContextFunctions': ["npgettext", "lazyNpgettext"],   // The name of the npgettext functions
 *         'quiet': false   // If true: do not output logs
 *     }
 *
 * @method main
 * @static
 * @param {Array} jsFiles list of js files to parse (can contain glob pattern)
 * @param {String} output the output file (.pot)
 * @param {Object} options additional options (optional, default: see above)
 * @param {Function} callback function called when everything is done (optional)
 */
extract.main = function(jsFiles, output, options, callback) {
    options = options || {};
    if (options.functions === undefined) {
        options.functions = ["_", "gettext", "lazyGettext", "gettext_noop", "N_"];
    }
    else if (typeof options.functions == "string") {
        options.functions = options.functions.split(",");
    }
    if (options.pluralFunctions === undefined) {
        options.pluralFunctions = ["ngettext", "lazyNgettext"];
    }
    else if (typeof options.pluralFunctions == "string") {
        options.pluralFunctions = options.pluralFunctions.split(",");
    }
    if (options.contextFunctions === undefined) {
        options.contextFunctions = ["pgettext", "lazyPgettext"];
    }
    else if (typeof options.contextFunctions == "string") {
        options.contextFunctions = options.contextFunctions.split(",");
    }
    if (options.pluralContextFunctions === undefined) {
        options.pluralContextFunctions = ["npgettext", "lazyNpgettext"];
    }
    else if (typeof options.pluralContextFunctions == "string") {
        options.pluralContextFunctions = options.pluralContextFunctions.split(",");
    }
    callback = callback || function(){};

    var files = [];
    var strings = {};
    var skipped = 0;

    async.each(jsFiles,

        function(jsFile, doneCb) {
           glob(jsFile, {}, function(error, matchingFiles) {
               files = files.concat(matchingFiles);
               doneCb();
           });
        },

        function() {
            async.each(files,

                function(file, doneCb) {
                    if (!helpers.isFile(file)) {
                        if (!helpers.isDir(file)) {
                            helpers.warn("File not found: " + file, options);
                            skipped += 1;
                        }
                        doneCb();
                        return;
                    }
                    helpers.log("  * Extracting strings from '" + file + "'", options);
                    var data = fs.readFileSync(file, {encoding: "utf-8"});
                    var extractedStrings = {};
                    var ext = file.toLowerCase().split(".");
                    ext = ext[ext.length-1];
                    if (["html", "htm", "xhtml", "xml", "twig"].indexOf(ext) >= 0) {
                        extractedStrings = extract.extractHtmlStrings(data.toString(), options.functions, options.pluralFunctions, options.contextFunctions, options.pluralContextFunctions);
                    }
                    else if (["jsx"].indexOf(ext) >= 0) {
                        try {
                            extractedStrings = extract.extractJsStrings(data.toString(), options.functions, options.pluralFunctions, options.contextFunctions, options.pluralContextFunctions, true);
                        } catch (error) {
                            helpers.warn(
                                "Line " + error.lineNumber +
                                ", column " + error.column +
                                ": " + error.toString(),
                                options
                            );
                            helpers.warn("File skipped due to syntax errors", options);
                            skipped += 1;
                            doneCb();
                            return;
                        }
                    }
                    else {
                        try {
                            extractedStrings = extract.extractJsStrings(data.toString(), options.functions, options.pluralFunctions, options.contextFunctions, options.pluralContextFunctions, false);
                        } catch (error) {
                            helpers.warn(
                                "Line " + error.lineNumber +
                                ", column " + error.column +
                                ": " + error.toString(),
                                options
                            );
                            helpers.warn("File skipped due to syntax errors", options);
                            skipped += 1;
                            doneCb();
                            return;
                        }
                    }
                    for (var str in extractedStrings) {
                        if (strings[str] === undefined) {
                            strings[str] = {};
                        }
                        for (var msgctxt in extractedStrings[str]) {
                            if (strings[str][msgctxt] === undefined) {
                                strings[str][msgctxt] = { refs: [] };
                            }
                            if (extractedStrings[str][msgctxt].msgid_plural) {
                                strings[str][msgctxt].msgid_plural = extractedStrings[str][msgctxt].msgid_plural;
                            }
                        }
                        for (var i=0 ; i<extractedStrings[str][msgctxt].refs.length ; i++) {
                            strings[str][msgctxt].refs.push({
                                file: file,
                                line: extractedStrings[str][msgctxt].refs[i]
                            });
                        }
                    }
                    doneCb();
                },

                function() {
                    helpers.log(
                        "\n\x1B[1;36m" + Object.keys(strings).length + "\x1B[0m string(s) extracted" +
                        ((skipped > 0) ? ", \x1B[1;31m" + skipped + "\x1B[0m file(s) skipped." : "."),
                        options);
                    fs.writeFile(output, extract.generatePo(strings), {encoding: "utf-8"}, function(error) {
                        if (error) {
                            helpers.error("An error occurred: " + error, options);
                        }
                        else {
                            helpers.ok("Translation template written: " + output, options);
                        }
                        callback(error);
                    });
                }
            );
        }
    );
};

/**
 * Extracts strings from the given Javascript source code.
 *
 * @method extractJsStrings
 * @static
 * @param {String} source The Javascript source code.
 * @param {string[]} functionsNames The name of the translation functions to search in the source.
 * @param {string[]} pluralFunctionsNames The name of the translation functions with plural support.
 * @param {string[]} contextFunctionsNames The name of the translation functions with context support.
 * @param {string[]} pluralContextFunctionsNames The name of the translation functions with plural and context support.
 * @param {boolean} [isJsx] whether source file is jsx
 * @return {Object} Translatable strings `{ <string>: { <context>: { msgid_plural: <plural>, refs: [<lines>] } } }`.
 */
extract.extractJsStrings = function(source, functionsNames, pluralFunctionsNames, contextFunctionsNames, pluralContextFunctionsNames, isJsx) {
    isJsx = isJsx || false;
    var strings = {};
    var ast = espree.parse(source, {
        tolerant: true,
        tokens: true,
        loc: true,
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
            jsx: isJsx,
        },
    });

    function _cleanString(str) {
        return new Function("return " + str + ";")();  // jshint ignore:line
    }

    var f_fn = false;         // In function flag
    var f_sp = false;         // In parenthesis flag
    var f_isPlural = false;   // plural forms function flag
    var f_isContext = false;  // context function flag
    var f_findPlural = false; // Find plural message
    var f_findMsgid = false;  // Find message id after context if found
    var msgBuff = "";         // Buff to concat splitted strings
    var msgid;                // msgid
    var line;                 // msgid line
    var msgid_plural;         // plural of the msgid string
    var msgctxt = "";         // context of the msgid string
    function pushString() {
        if (strings[msgid] === undefined) {
            strings[msgid] = {};
        }
        if (strings[msgid][msgctxt] === undefined) {
            strings[msgid][msgctxt] = { refs: [] };
            if (f_isPlural) {
                strings[msgid][msgctxt].msgid_plural = msgid_plural;
            }
        }
        strings[msgid][msgctxt].refs.push(line);
    }
    function stop() {
        f_fn = false;
        f_sp = false;
        f_isPlural = false;
        f_isContext = false;
        f_findPlural = false;
        f_findMsgid = false;
        msgBuff = "";
        msgid = undefined;
        line = undefined;
        msgid_plural = undefined;
        msgctxt = "";
    }
    for (var i=0 ; i<ast.tokens.length ; i++) {

        // ?
        if (!f_fn && !f_sp) {
            if (ast.tokens[i].type == "Identifier") {
                if (functionsNames.indexOf(ast.tokens[i].value) > -1) {
                    f_fn = true;
                } else if (pluralFunctionsNames.indexOf(ast.tokens[i].value) > -1) {
                    f_fn = true;
                    f_isPlural = true;
                    f_findPlural = false;
                } else if (contextFunctionsNames.indexOf(ast.tokens[i].value) > -1) {
                    f_fn = true;
                    f_isContext = true;
                    f_findMsgid = false;
                } else if (pluralContextFunctionsNames.indexOf(ast.tokens[i].value) > -1) {
                    f_fn = true;
                    f_isPlural = true;
                    f_isContext = true;
                    f_findPlural = false;
                    f_findMsgid = false;
                }
            }
        }

        // functionName
        else if (f_fn && !f_sp) {
            if (ast.tokens[i].type == "Punctuator" && ast.tokens[i].value == "(") {
                f_sp = true;
                msgBuff = "";
            }
            else {
                stop();
            }
        }

        // functionName (
        else if (f_fn && f_sp) {
            if (ast.tokens[i].type == "String" || ast.tokens[i].type == "Numeric") {
                msgBuff += _cleanString(ast.tokens[i].value);
            }
            else if (ast.tokens[i].type == "Punctuator" && ast.tokens[i].value == "+") {
                continue;
            }
            else if (ast.tokens[i].type == "Identifier") {
                msgBuff = "";
                stop();
            }
            else {
                if (f_isContext) {
                    if (f_isPlural) {
                        // npgettext
                        if (f_findPlural) {
                            // third parameter: msgid_plural
                            msgid_plural = msgBuff;
                            pushString();
                            stop();
                        } else if (f_findMsgid) {
                            // second parameter: msgid
                            msgid = msgBuff;
                            msgBuff = "";
                            f_findPlural = true;
                        } else {
                            // first parameter: context
                            msgctxt = msgBuff;
                            line = ast.tokens[i].loc.start.line;
                            msgBuff = "";
                            f_findMsgid = true;
                        }

                    } else {
                        // pgettext
                        if (f_findMsgid) {
                            // second parameter: msgid
                            msgid = msgBuff;
                            pushString();
                            stop();
                        } else {
                            // first parameter: context
                            msgctxt = msgBuff;
                            line = ast.tokens[i].loc.start.line;
                            msgBuff = "";
                            f_findMsgid = true;
                        }
                    }

                } else if (f_isPlural) {
                    // ngettext
                    if (f_findPlural) {
                        // second paramter: msgid_plural
                        msgid_plural = msgBuff;
                        pushString();
                        stop();
                    } else {
                        // first parameter: msgid
                        msgid = msgBuff;
                        line = ast.tokens[i].loc.start.line;
                        msgBuff = "";
                        f_findPlural = true;
                    }

                } else {
                    // gettext
                    msgid = msgBuff;
                    line = ast.tokens[i].loc.start.line;
                    pushString();
                    stop();
                }
            }
        }
    }

    return strings;
};

/**
 * Extracts strings from the given HTML.
 *
 * @method extractHtmlStrings
 * @static
 * @param {String} source The HTML source code.
 * @param {string[]} functionsNames The name of the translation functions to search in the source.
 * @param {string[]} pluralFunctionsNames The name of the translation functions with plural support.
 * @param {string[]} contextFunctionsNames The name of the translation functions with context support.
 * @param {string[]} pluralContextFunctionsNames The name of the translation functions with plural and context support.
 * @return {Object} Translatable strings `{ <string>: { "": { [<lines>] } } }`.
 */
extract.extractHtmlStrings = function(source, functionsNames, pluralFunctionsNames, contextFunctionsNames, pluralContextFunctionsNames) {
    var $ = cheerio.load(source);
    var result = {};

    function extractStringsFromData(data, element) {
        try {
            var dataObj = new Function("return " + data)();
            for (var key in dataObj) {
                if (typeof dataObj[key] === "string" && functionsNames.includes(dataObj[key].slice(0, 1))) {
                    var str = dataObj[key].slice(2, -2); // Remove _(...)
                    result[str] = { "": { refs: [$(element).attr("x-data")] }};
                }
            }
        } catch (e) {
            // Handle error if dataObj is not a valid JavaScript object
        }
    }

    $("[x-data]").each(function(index, element) {
        var xDataContent = $(element).attr("x-data");
        if (xDataContent) {
            extractStringsFromData(xDataContent, element);
        }
    });

    $("[stonejs]").each(function(index, element) {
        result[$(element).html()] = { "": { refs: [0] }};
    });

    $("script").each(function(index, element) {
        var scriptContent = $(element).html();
        if (scriptContent) {
            var extractedJsStrings = extract.extractJsStrings(scriptContent, functionsNames, pluralFunctionsNames, contextFunctionsNames, pluralContextFunctionsNames, false);
            for (var str in extractedJsStrings) {
                if (result[str] === undefined) {
                    result[str] = {};
                }
                for (var msgctxt in extractedJsStrings[str]) {
                    if (result[str][msgctxt] === undefined) {
                        result[str][msgctxt] = { refs: [] };
                    }
                    if (extractedJsStrings[str][msgctxt].msgid_plural) {
                        result[str][msgctxt].msgid_plural = extractedJsStrings[str][msgctxt].msgid_plural;
                    }
                    result[str][msgctxt].refs = result[str][msgctxt].refs.concat(extractedJsStrings[str][msgctxt].refs);
                }
            }
        }
    });

    return result;
};

/**
 * Generates the .po file.
 *
 * @method generatePo
 * @static
 * @param {Object} strings the strings `{ "<msgid>": { "msgctxt": { msgid_plural: "msgid_plural", refs: [{file: String, line: Number}] } } }`.
 * @return {String} the generated po file.
 */
extract.generatePo = function(strings) {

    function _buildRef(refs) {
        var result = "";
        for (var i=0 ; i<refs.length ; i++) {
            if (i > 0) result += "\n";
            result += refs[i].file + ":" + refs[i].line;
        }
        return result;
    }

    var date = new Date();
    var data = {
        "charset": "utf-8",

        headers: {
            "mime-version": "1.0",
            "content-type": "text/plain; charset=utf-8",
            "content-transfer-encoding": "8bit",
            "pot-creation-date": helpers.dateFormat(date),
            "po-revision-date": helpers.dateFormat(date),
            "language": "C",
            "plural-forms": "nplurals=2; plural=(n != 1);"
        },

        translations: {
            "": {
                // "<msgid>" {
                //     msgctxt: "<msgctxt>",
                //     msgid: "<msgid>",
                //     msgid_plural: "<msgid_plural>",
                //     msgstr: ["<msgstr>"],
                //     comments: {
                //         reference: "<ref1>\n<ref2>"
                //     }
                // }
            }
        }
    };

    function _setMessage(msgid, msgctxt) {
        var msgid_plural = strings[msgid][msgctxt].msgid_plural;
        if (!data.translations[msgctxt]) data.translations[msgctxt] = {};
        data.translations[msgctxt][msgid] = {
            msgctxt: msgctxt || undefined,
            msgid: msgid,
            msgid_plural: msgid_plural || undefined,
            msgstr: msgid_plural ? ["", ""] : "",
            comments: {
                reference: _buildRef(strings[msgid][msgctxt].refs)
            }
        };
    }

    for (var msgid in strings) {
        for (var msgctxt in strings[msgid]) {
            _setMessage(msgid, msgctxt);
        }
    }

    return gettextParser.po.compile(data).toString();
};

module.exports = extract;
