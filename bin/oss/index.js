const { Command } = require(`clipanion`);
const fs = require('fs-extra');
const inquirer = require('inquirer');
const path = require('path');
const glob = require('glob');
const chalk = require('chalk');
const { execFile } = require(`child_process`);
const { promisify } = require(`util`);

const templates = require('./templates');

const execFileP = promisify(execFile);
const maxBuffer = 1024 * 1024;

const execute = (cmd, args, cwd) => execFileP(cmd, args, { maxBuffer, cwd });

const NAME = 'build-plugin';
const ROOT = path.join(__dirname, '../../');

class OSS extends Command {
    name = 'build-plugin';
    getFolders(filePath) {
        return fs.readdirSync(filePath, { withFileTypes: true})
            .filter(f => f.isDirectory())
            .map(f => f.name)
            .sort();
    }

    chooseFolder(folderPath, select = false) {
        const folders = this.getFolders(folderPath);
        const name = select ? 'folders' : 'folder';
        return inquirer.prompt([
            {
                type: select ? 'checkbox' : 'list',
                name,
                message: `Which ${name} do you want to make open source?`,
                choices: folders
            }
        ]);
    }

    async replaceFiles(folderPath, subfolders) {
        const fileTypes = [ 'ts', 'tsx', 'js', 'jsx'];
        const files = glob.sync(`${folderPath}/@(${subfolders.join('|')})/**/*.@(${fileTypes.join('|')})`);

        for (const file of files) {
            const fileName = chalk.green.bold(file.replace(ROOT, ''));
            try {
                const content = await fs.readFile(file, { encoding: 'utf8' });
                await fs.writeFile(file, `${templates.header}\n${content.replace(templates.headerRX, '')}`);
                this.context.stdout.write(`Processed ${fileName}.\n`);
            } catch (e) {
                this.context.stderr.write(e.toString());
            }
        }
    }

    async applyHeader() {
        const subfolders = (await this.chooseFolder(
            ROOT,
            true
        )).folders;

        await this.replaceFiles(ROOT, subfolders);
    }

    async apply3rdPartiesLicenses() {
        const { stdout } = await execute('yarn', ['licenses-csv'], ROOT);
        await fs.writeFile(path.join(ROOT, 'LICENSES-3rdparty.csv'), stdout);
    }

    async applyNotice() {
        await fs.writeFile(path.join(ROOT, 'NOTICE'), templates.notice(NAME));
    }

    async applyLicense() {
        const { license } = await inquirer.prompt([
            {
                type: 'list',
                name: 'license',
                message: `Which license do you want to use?`,
                choices: Object.keys(templates.licenses)
            }
        ]);
        const licenseContent = await fs.readFile(path.join(__dirname, templates.licenses[license]));
        await fs.writeFile(path.join(ROOT, 'LICENSE'), licenseContent);
    }

    async execute() {
        await this.applyHeader();
        this.context.stdout.write('Done header.\n');
        await this.apply3rdPartiesLicenses();
        this.context.stdout.write('Done 3rd parties licenses.\n');
        await this.applyNotice();
        this.context.stdout.write('Done notice.\n');
        await this.applyLicense();
        this.context.stdout.write('Done license.\n');
    }
}

OSS.addPath(`oss`);

module.exports = [OSS];
