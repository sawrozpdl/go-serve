# सर्भरको विवरण — Server system information

*IRD office checklist item 11(ज). Generate on the production box and paste the output below:*

```bash
sudo infra/datahub/sysinfo.sh > /tmp/sysinfo.txt
```

```
{{paste output: hostname, OS, kernel, CPU, memory, disks, network interfaces with MAC addresses,
  public IP, PostgreSQL version, Go Serve version and commit, uptime}}
```

The café provides `dxdiag` and `getmac /v` output for its own billing computers, or the Android device information for phones and tablets.
