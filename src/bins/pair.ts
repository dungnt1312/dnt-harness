/**
 * Print a fresh single-use pairing code for a server that is already running
 * is not possible from here: the code lives in that process. This bin is the
 * documented entry for operators who start the web server themselves — the
 * web bin prints the code. Tests and recovery call `issuePairingCode` on the
 * live server handle.
 *
 * Usage stays side-effect free so a stray invocation cannot mint a credential
 * outside the running host.
 */
process.stderr.write('pairing codes are issued by the running web server at startup\n')
process.exitCode = 1
