# GAMS Connect and NEOS

## GAMS Connect

GAMS Connect moves data between files and GAMS (Excel, CSV, GDX and more). You describe the steps in a YAML file. The extension helps you write and run it. You need GAMS to run a Connect file.

### How do I get help while I write a Connect file?

Name your file `something.connect.yaml` (or `.connect.yml`). It is then checked against the Connect rules. You get completion and hover text.

This help comes from the extension **YAML** by Red Hat. The extension offers to install it once. You can also install it from the Extensions view.

For a YAML file with another name, open it and run **GAMS: Treat as Connect File**. It is also in the right-click menu of the editor. The extension adds the file to the setting `yaml.schemas` of your workspace.

### How do I start from an example?

In a YAML file, type one of these words and press Tab:

- `gams-connect-excel-to-gdx`
- `gams-connect-csv-to-gdx`
- `gams-connect-gdx-to-excel`

Then change the file names and options.

### How do I run a Connect file?

Click the play button at the top right of the editor, or run **GAMS: Run Connect File**. The extension saves the file and runs `gamsconnect` in the folder of the file. The output appears in the **GAMS Connect** output panel. Cancel the progress message to stop the run.

When it finishes, the extension offers **Open in GDX Viewer** for the `.gdx` files that the file wrote.

### How do I pass values into a Connect file?

Write `%name%` in the YAML file. Add `name=value` to the setting `gams.connect.arguments`. Example: `["scenario=base"]`. Each `%scenario%` is then replaced by `base`.

Put quotes around a placeholder: `"%name%"`. A plain YAML value cannot start with `%`, and the YAML extension reports an error for it.

## NEOS Server

The NEOS Server solves models on a remote computer. This is useful when you do not have the solver or a license.

### Is my model private?

**No.** When you run on NEOS, your model data is sent to the NEOS Server. NEOS gives no promise of confidentiality for your data or your model. Do not use NEOS for confidential work. Read the terms of use at <https://neos-server.org/neos/termofuse.html>.

The extension asks for your confirmation before the first submission. It shows the terms and the details (file, server, email, priority). The confirm button reads "I agree to the Terms of Use and submit". Later you can choose **Submit, don't ask again**. Run **GAMS: Reset NEOS Terms Confirmation** to be asked again.

### How do I run on NEOS?

1. Open **Settings** and set `gams.neos.email`. NEOS requires an email address. The extension never fills it in for you. Only your user settings are read for the email and the server, not the workspace settings.
2. Open your `.gms` file.
3. Run **GAMS: Run on NEOS** from the Command Palette.
4. Read the confirmation and agree.

The extension first compiles your model on your computer (no solve). Then it sends the result, your parameters and your email address to NEOS. The log shows the progress. When the job ends, you can open the listing and the GDX file. The results are in a folder with the name of your model.

`gams.neos.priority` can be `short` (limit of 5 minutes, live log) or `long` (no limit; the job number and password are in the log and the full log arrives at the end). `gams.neos.forceGdx` asks NEOS to return a GDX file. **GAMS: Stop** asks NEOS to cancel the job. NEOS may ignore the request.
